/**
 * Skills, runnable, named capabilities surfaced in the composer's `/` menu and
 * the dedicated Skills tab. These mirror the standard skills any agent (Claude
 * Code and others) can run; selecting one drops its scaffold into the composer
 * ready to send. `goal` is special (see `kind: 'goal'`): it starts a
 * long-running background agent that works until a condition is met.
 *
 * Every skill also carries a small **workflow**, a node graph describing the
 * steps it runs through (trigger → context → agent → tools → output, with loops
 * and branches). The Skills tab renders this like an n8n / Make canvas so the
 * user can see what a skill actually does before running it. `layoutWorkflow`
 * (pure) turns a graph into positioned nodes for the visualizer.
 */

export interface SkillDef {
  id: string;
  /** Invoked as `/name` in the composer. */
  name: string;
  description: string;
  /** Text dropped into the composer when the skill is picked. */
  template: string;
  /** Featured at the top of the `/` menu with an accent. */
  highlighted?: boolean;
  /** 'goal' routes to a background "work until done" task instead of a normal turn. */
  kind?: 'prompt' | 'goal';
  /** Grouping shown in the Skills tab. */
  category: SkillCategory;
  /** Built-in tools the skill typically uses (display only). */
  tools?: string[];
  /** The step graph rendered in the Skills tab. */
  workflow: SkillWorkflow;
  origin?: SkillOrigin;
}

export type SkillCategory = 'Research & planning' | 'Code quality' | 'Delivery' | 'Automation' | 'Imported';

/** Agent tools whose SKILL.md folders Nekko Agent can read. */
export type ExternalSkillTool = 'claude' | 'codex' | 'gemini' | 'agents';

/** Where an imported skill came from; absent for built-in and marketplace skills. */
export interface SkillOrigin {
  tool: ExternalSkillTool;
  scope: 'user' | 'project';
  /** The skill's folder on disk. */
  dir: string;
}

/** A node in a skill's workflow graph. */
export type SkillNodeKind =
  | 'trigger' // the `/command` and its input
  | 'context' // gather files / diff / repo state
  | 'agent' // model reasoning step
  | 'tool' // a concrete tool call (edit, run, git, web)
  | 'decision' // a branch / condition check
  | 'loop' // an iterating step
  | 'output'; // the final deliverable

export interface SkillNode {
  id: string;
  kind: SkillNodeKind;
  label: string;
  /** One-line explanation shown under the node label. */
  detail?: string;
}

export interface SkillEdge {
  from: string;
  to: string;
  label?: string;
  /** A return/loop edge (drawn dashed, routed around), ignored for layering. */
  back?: boolean;
}

export interface SkillWorkflow {
  nodes: SkillNode[];
  edges: SkillEdge[];
}

// --- Workflow builders (kept terse; each skill gets a meaningful graph) ---

const wf = (nodes: SkillNode[], edges: SkillEdge[]): SkillWorkflow => ({ nodes, edges });

/** Standard skills available in every chat. */
export const SKILLS: SkillDef[] = [
  {
    id: 'goal',
    name: 'goal',
    description: 'Keep an agent working autonomously until a goal/condition is met',
    template: '/goal ',
    highlighted: true,
    kind: 'goal',
    category: 'Automation',
    tools: ['all tools', 'spawn_agent'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/goal <condition>', detail: 'Background task starts' },
        { id: 'plan', kind: 'agent', label: 'Plan approach', detail: 'Break the goal into steps' },
        { id: 'work', kind: 'loop', label: 'Do the work', detail: 'Edit, run, search, delegate' },
        { id: 'check', kind: 'decision', label: 'Goal met?', detail: 'Agent judges the condition' },
        { id: 'out', kind: 'output', label: 'Done', detail: 'Stop + report result' },
      ],
      [
        { from: 't', to: 'plan' },
        { from: 'plan', to: 'work' },
        { from: 'work', to: 'check' },
        { from: 'check', to: 'work', label: 'no', back: true },
        { from: 'check', to: 'out', label: 'yes' },
      ],
    ),
  },
  {
    id: 'research',
    name: 'research',
    description: 'Deep, multi-source research with a cited report',
    template: 'Research the following thoroughly and produce a well-cited report. Work from sources you can actually open: pages and links I give you, read with fetch_url, and the browser when it is available. If finding sources would need a web search engine you do not have, say so instead of guessing:\n\n',
    category: 'Research & planning',
    tools: ['fetch_url', 'browser'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/research <topic>' },
        { id: 'decompose', kind: 'agent', label: 'Decompose', detail: 'Sub-questions to answer' },
        { id: 'gather', kind: 'agent', label: 'Gather sources', detail: 'Find relevant URLs' },
        { id: 'r1', kind: 'tool', label: 'Read source', detail: 'Fetch URL · source 1' },
        { id: 'r2', kind: 'tool', label: 'Read source', detail: 'Fetch URL · source 2' },
        { id: 'r3', kind: 'tool', label: 'Read source', detail: 'Fetch URL · source 3' },
        { id: 'extract', kind: 'agent', label: 'Extract facts', detail: 'Read pages and extract information' },
        { id: 'verify', kind: 'agent', label: 'Verify claims', detail: 'Cross-check, drop weak ones' },
        { id: 'out', kind: 'output', label: 'Cited report' },
      ],
      [
        { from: 't', to: 'decompose' },
        { from: 'decompose', to: 'gather' },
        { from: 'gather', to: 'r1' },
        { from: 'gather', to: 'r2' },
        { from: 'gather', to: 'r3' },
        { from: 'r1', to: 'extract' },
        { from: 'r2', to: 'extract' },
        { from: 'r3', to: 'extract' },
        { from: 'extract', to: 'verify' },
        { from: 'verify', to: 'out' },
      ],
    ),
  },
  {
    id: 'plan',
    name: 'plan',
    description: 'Produce a step-by-step implementation plan before coding',
    template: 'Create a detailed, step-by-step implementation plan for:\n\n',
    category: 'Research & planning',
    tools: ['read_file', 'search'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/plan <task>' },
        { id: 'ctx', kind: 'context', label: 'Read codebase', detail: 'Relevant files + structure' },
        { id: 'agent', kind: 'agent', label: 'Design approach', detail: 'Tradeoffs, sequencing' },
        { id: 'out', kind: 'output', label: 'Step-by-step plan' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'agent' },
        { from: 'agent', to: 'out' },
      ],
    ),
  },
  {
    id: 'review',
    name: 'review',
    description: 'Review the current code/diff for bugs and improvements',
    template: 'Review the current changes for correctness bugs, edge cases, and possible improvements.',
    category: 'Code quality',
    tools: ['git diff', 'read_file'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/review' },
        { id: 'ctx', kind: 'context', label: 'Load diff', detail: 'Changed files + context' },
        { id: 'agent', kind: 'agent', label: 'Find issues', detail: 'Bugs, edge cases, smells' },
        { id: 'out', kind: 'output', label: 'Findings report' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'agent' },
        { from: 'agent', to: 'out' },
      ],
    ),
  },
  {
    id: 'security-review',
    name: 'security-review',
    description: 'Audit the changes for security vulnerabilities',
    template:
      'Do a focused security review of the current changes: look for injection, auth, secret-handling, and unsafe-input issues.',
    category: 'Code quality',
    tools: ['git diff', 'read_file', 'search'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/security-review' },
        { id: 'ctx', kind: 'context', label: 'Load diff' },
        { id: 'audit', kind: 'agent', label: 'Audit', detail: 'Injection, auth, secrets, input' },
        { id: 'check', kind: 'decision', label: 'Vulnerabilities?' },
        { id: 'report', kind: 'output', label: 'Risk report', detail: 'Severity + fixes' },
        { id: 'clear', kind: 'output', label: 'Looks clean' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'audit' },
        { from: 'audit', to: 'check' },
        { from: 'check', to: 'report', label: 'yes' },
        { from: 'check', to: 'clear', label: 'no' },
      ],
    ),
  },
  {
    id: 'simplify',
    name: 'simplify',
    description: 'Simplify and de-duplicate the changed code',
    template:
      'Review the changed code for reuse, simplification, and clarity, then apply the cleanups (no behavior change).',
    category: 'Code quality',
    tools: ['git diff', 'edit_file'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/simplify' },
        { id: 'ctx', kind: 'context', label: 'Load changes' },
        { id: 'agent', kind: 'agent', label: 'Find cleanups', detail: 'Reuse, dedupe, clarity' },
        { id: 'apply', kind: 'tool', label: 'Apply edits' },
        { id: 'out', kind: 'output', label: 'Cleaner code' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'agent' },
        { from: 'agent', to: 'apply' },
        { from: 'apply', to: 'out' },
      ],
    ),
  },
  {
    id: 'test',
    name: 'test',
    description: 'Write tests covering the important edge cases',
    template: 'Write tests for this code, covering the important edge cases.',
    category: 'Code quality',
    tools: ['read_file', 'write_file', 'run'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/test' },
        { id: 'ctx', kind: 'context', label: 'Read code' },
        { id: 'agent', kind: 'agent', label: 'Write tests', detail: 'Cover edge cases' },
        { id: 'write', kind: 'tool', label: 'Write files' },
        { id: 'run', kind: 'tool', label: 'Run suite' },
        { id: 'out', kind: 'output', label: 'Passing tests' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'agent' },
        { from: 'agent', to: 'write' },
        { from: 'write', to: 'run' },
        { from: 'run', to: 'out' },
      ],
    ),
  },
  {
    id: 'explain',
    name: 'explain',
    description: 'Explain how this code works, step by step',
    template: 'Explain how this code works, step by step.',
    category: 'Research & planning',
    tools: ['read_file', 'search'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/explain' },
        { id: 'ctx', kind: 'context', label: 'Read code' },
        { id: 'agent', kind: 'agent', label: 'Trace logic' },
        { id: 'out', kind: 'output', label: 'Explanation' },
      ],
      [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'agent' },
        { from: 'agent', to: 'out' },
      ],
    ),
  },
  {
    id: 'fix',
    name: 'fix',
    description: 'Find and fix the bug, explaining the root cause',
    template: 'Find and fix the bug. Explain the root cause and the fix.',
    category: 'Code quality',
    tools: ['read_file', 'edit_file', 'run'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/fix' },
        { id: 'repro', kind: 'context', label: 'Reproduce', detail: 'Read code + run' },
        { id: 'diag', kind: 'agent', label: 'Diagnose', detail: 'Find root cause' },
        { id: 'edit', kind: 'tool', label: 'Apply fix' },
        { id: 'run', kind: 'tool', label: 'Run tests' },
        { id: 'check', kind: 'decision', label: 'Fixed?' },
        { id: 'out', kind: 'output', label: 'Fix + root cause' },
      ],
      [
        { from: 't', to: 'repro' },
        { from: 'repro', to: 'diag' },
        { from: 'diag', to: 'edit' },
        { from: 'edit', to: 'run' },
        { from: 'run', to: 'check' },
        { from: 'check', to: 'diag', label: 'no', back: true },
        { from: 'check', to: 'out', label: 'yes' },
      ],
    ),
  },
  {
    id: 'commit',
    name: 'commit',
    description: 'Stage and commit the current changes with a good message',
    template: 'Stage and commit the current changes with a clear, conventional commit message.',
    category: 'Delivery',
    tools: ['git status', 'git diff', 'git commit'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/commit' },
        { id: 'status', kind: 'tool', label: 'git status', detail: 'Stage changes' },
        { id: 'msg', kind: 'agent', label: 'Write message', detail: 'Conventional commit' },
        { id: 'commit', kind: 'tool', label: 'git commit' },
        { id: 'out', kind: 'output', label: 'Committed' },
      ],
      [
        { from: 't', to: 'status' },
        { from: 'status', to: 'msg' },
        { from: 'msg', to: 'commit' },
        { from: 'commit', to: 'out' },
      ],
    ),
  },
  {
    id: 'pr',
    name: 'pr',
    description: 'Open a pull request for the current branch',
    template: 'Push the current branch and open a pull request. Follow the repository\'s PR conventions (if any) and include an explicit **Unfinished work / release blockers** section listing incomplete scope, known bugs, unsupported platforms, missing tests or visual evidence, and verification limitations. Then see it through: wait for checks, fix what this change broke, and when nothing blocks it mark the PR ready and merge it the way the repository lands work. Residual notes in Unfinished work are not a reason to leave it in draft; only a real release blocker is, and name it if you stop.',
    category: 'Delivery',
    tools: ['git push', 'gh pr create'],
    workflow: wf(
      [
        { id: 't', kind: 'trigger', label: '/pr' },
        { id: 'push', kind: 'tool', label: 'git push' },
        { id: 'desc', kind: 'agent', label: 'Write description', detail: 'Summary + unfinished work section' },
        { id: 'review', kind: 'agent', label: 'Review PR', detail: 'Check conventions + visual evidence' },
        { id: 'create', kind: 'tool', label: 'gh pr create' },
        { id: 'checks', kind: 'tool', label: 'Wait for checks', detail: 'Fix what this change broke' },
        { id: 'ready', kind: 'tool', label: 'gh pr ready + merge', detail: 'Unless a named release blocker' },
        { id: 'out', kind: 'output', label: 'PR merged' },
      ],
      [
        { from: 't', to: 'push' },
        { from: 'push', to: 'desc' },
        { from: 'desc', to: 'review' },
        { from: 'review', to: 'create' },
        { from: 'create', to: 'checks' },
        { from: 'checks', to: 'ready' },
        { from: 'ready', to: 'out' },
      ],
    ),
  },
];

/**
 * Match skills by a `/`-query (name substring), highlighted ones first.
 * `extra` lets callers merge in installed marketplace skills (built-ins win on
 * a name collision).
 */
export function matchSkills(query: string, extra: SkillDef[] = []): SkillDef[] {
  const q = query.toLowerCase();
  const names = new Set(SKILLS.map((s) => s.name));
  const all = [...SKILLS, ...extra.filter((s) => !names.has(s.name))];
  return all.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).sort(
    (a, b) => Number(!!b.highlighted) - Number(!!a.highlighted),
  );
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  'Research & planning',
  'Code quality',
  'Delivery',
  'Automation',
  'Imported'
];

// --- Workflow layout (pure; consumed by the Skills tab visualizer) ---

/** Where the layout placed a node. */
export interface NodePlacement {
  layer: number;
  row: number;
  x: number;
  y: number;
}

export type LaidOutNode = SkillNode & NodePlacement;

export interface WorkflowLayout<N = LaidOutNode, E = SkillEdge> {
  nodes: N[];
  edges: E[];
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
}

/** The minimum a node needs to be laid out. */
export interface GraphNode {
  id: string;
}

/** The minimum an edge needs; `back` edges are drawn as loops, not layered. */
export interface GraphEdge {
  from: string;
  to: string;
  back?: boolean;
}

export interface LayoutOptions {
  nodeW?: number;
  nodeH?: number;
  gapX?: number;
  gapY?: number;
  margin?: number;
}

/**
 * Left-to-right layered layout. Each node's column (layer) is its longest path
 * from a root over forward edges (back/loop edges are ignored for layering);
 * nodes sharing a layer are stacked and vertically centred so fan-outs splay
 * symmetrically. Pure + deterministic so it can be unit-tested.
 *
 * Generic over the node and edge shapes: it only reads ids and edge ends, and
 * carries everything else through untouched, so a skill's graph and a workflow's
 * step graph are drawn by the same code.
 */
export function layoutWorkflow<N extends GraphNode, E extends GraphEdge>(
  workflow: { nodes: N[]; edges: E[] },
  opts: LayoutOptions = {},
): WorkflowLayout<N & NodePlacement, E> {
  const nodeW = opts.nodeW ?? 156;
  const nodeH = opts.nodeH ?? 60;
  const gapX = opts.gapX ?? 64;
  const gapY = opts.gapY ?? 24;
  const margin = opts.margin ?? 24;

  const forward = workflow.edges.filter((e) => !e.back);
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>();
  for (const n of workflow.nodes) incoming.set(n.id, 0);
  for (const e of forward) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  // Longest-path layering: relax forward edges until stable (DAG, small graphs).
  const layer = new Map<string, number>();
  for (const n of workflow.nodes) layer.set(n.id, 0);
  for (let i = 0; i < workflow.nodes.length; i++) {
    let changed = false;
    for (const e of forward) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      const cand = (layer.get(e.from) ?? 0) + 1;
      if (cand > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, cand);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group nodes by layer, preserving declaration order within a layer.
  const layers = new Map<number, N[]>();
  for (const n of workflow.nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  }

  const colHeight = (count: number) => count * nodeH + Math.max(0, count - 1) * gapY;
  const maxRows = Math.max(...[...layers.values()].map((g) => g.length), 1);
  const canvasInner = colHeight(maxRows);

  const laid: Array<N & NodePlacement> = [];
  for (const [l, group] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const colH = colHeight(group.length);
    const startY = margin + (canvasInner - colH) / 2;
    group.forEach((n, row) => {
      laid.push({
        ...n,
        layer: l,
        row,
        x: margin + l * (nodeW + gapX),
        y: startY + row * (nodeH + gapY),
      });
    });
  }

  const layerCount = layers.size;
  const width = margin * 2 + layerCount * nodeW + Math.max(0, layerCount - 1) * gapX;
  const height = margin * 2 + canvasInner;

  return { nodes: laid, edges: workflow.edges, width, height, nodeW, nodeH };
}
