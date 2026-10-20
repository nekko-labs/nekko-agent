/**
 * Spec-driven development, methodologies, artifact definitions, and the pure
 * helpers for parsing/toggling a tasks checklist.
 *
 * A *methodology* is an ordered set of *artifacts* (markdown files in the
 * workspace root). Artifacts are generated in order and chained: a later
 * artifact is given the earlier ones as context (e.g. the plan sees the spec,
 * the tasks see the spec + plan). The engine (crates/nekko-workspace spec.rs,
 * with the model call in nekkod) does the model calls; everything in this
 * file is pure so the renderer and tests can share it.
 */

/** What kind of artifact this is, drives the generation prompt in the host. */
export type SpecDocRole = 'spec' | 'plan' | 'tasks';

export interface SpecDocDef {
  /** Stable id, unique within a methodology. */
  id: string;
  /** File written to the workspace root, e.g. `spec.md`. */
  filename: string;
  /** Short label for the UI, e.g. "Spec". */
  label: string;
  /** Drives the system prompt + how prior docs are chained in. */
  role: SpecDocRole;
  /** One-line description shown under the label. */
  description: string;
}

export interface SpecMethodology {
  id: string;
  label: string;
  /** One-line description of the workflow. */
  description: string;
  /** Ordered artifacts, earlier ones are fed into later ones as context. */
  docs: SpecDocDef[];
}

/**
 * Built-in methodologies. `spec-tasks` is the default lightweight
 * spec/tasks flow; `nekko-agent` matches this project's spec/plan/tasks
 * convention; `kiro` mirrors Amazon Kiro's requirements/design/tasks naming;
 * `lean` is the original single-spec flow.
 */
export const SPEC_METHODOLOGIES: SpecMethodology[] = [
  {
    id: 'spec-tasks',
    label: 'Spec → Tasks',
    description: 'A spec then a task checklist, no separate plan.',
    docs: [
      { id: 'spec', filename: 'spec.md', label: 'Spec', role: 'spec', description: 'What & why, vision, users, requirements.' },
      { id: 'tasks', filename: 'tasks.md', label: 'Tasks', role: 'tasks', description: 'Discrete, checkable work items.' },
    ],
  },
  {
    id: 'nekko-agent',
    label: 'Spec → Plan → Tasks',
    description: 'Nekko Agent default: a spec, a technical plan, then a task checklist.',
    docs: [
      { id: 'spec', filename: 'spec.md', label: 'Spec', role: 'spec', description: 'What & why, vision, users, requirements.' },
      { id: 'plan', filename: 'plan.md', label: 'Plan', role: 'plan', description: 'How, architecture, stack, conventions.' },
      { id: 'tasks', filename: 'tasks.md', label: 'Tasks', role: 'tasks', description: 'Discrete, checkable work items.' },
    ],
  },
  {
    id: 'kiro',
    label: 'Requirements → Design → Tasks',
    description: 'Kiro-style: requirements (user stories), technical design, tasks.',
    docs: [
      { id: 'requirements', filename: 'requirements.md', label: 'Requirements', role: 'spec', description: 'User stories & acceptance criteria.' },
      { id: 'design', filename: 'design.md', label: 'Design', role: 'plan', description: 'Architecture, data model, sequencing.' },
      { id: 'tasks', filename: 'tasks.md', label: 'Tasks', role: 'tasks', description: 'Discrete, trackable implementation tasks.' },
    ],
  },
  {
    id: 'lean',
    label: 'Single spec',
    description: 'Just one living spec.md, synthesized from the conversation.',
    docs: [
      { id: 'spec', filename: 'spec.md', label: 'Spec', role: 'spec', description: 'A single living spec for the workspace.' },
    ],
  },
];

export const DEFAULT_SPEC_METHODOLOGY = 'spec-tasks';

/** Look up a methodology by id, falling back to the default. */
export function getMethodology(id: string | undefined): SpecMethodology {
  return SPEC_METHODOLOGIES.find((m) => m.id === id) ?? SPEC_METHODOLOGIES[0];
}

/** Live status of one artifact for the UI. */
export interface SpecDocStatus extends SpecDocDef {
  /** Absolute path of the file. */
  path: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /** Current file contents (empty when missing). */
  content: string;
}

/** A single parsed checklist item from a tasks document. */
export interface SpecTask {
  /** 0-based index of the line in the file. */
  line: number;
  /** Item text (without the `- [ ]` prefix). */
  text: string;
  done: boolean;
}

const TASK_RE = /^(\s*[-*]\s*)\[([ xX])\]\s?(.*)$/;

/** Extract markdown checklist items (`- [ ]` / `- [x]`) from a tasks doc. */
export function parseTasks(markdown: string): SpecTask[] {
  const out: SpecTask[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_RE.exec(lines[i]);
    if (m) out.push({ line: i, text: m[3].trim(), done: m[2].toLowerCase() === 'x' });
  }
  return out;
}

/**
 * Flip the checkbox state of the checklist item on `lineIndex`, returning the
 * rewritten markdown. A no-op (returns the input unchanged) if that line isn't
 * a checklist item.
 */
export function toggleTaskLine(markdown: string, lineIndex: number): string {
  const lines = markdown.split('\n');
  const line = lines[lineIndex];
  if (line == null) return markdown;
  const m = TASK_RE.exec(line);
  if (!m) return markdown;
  const checked = m[2].toLowerCase() === 'x';
  lines[lineIndex] = `${m[1]}[${checked ? ' ' : 'x'}] ${m[3]}`;
  return lines.join('\n');
}
