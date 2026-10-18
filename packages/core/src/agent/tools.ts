import type { ToolSpec } from '../providers/types.js';
import { BROWSER_ACTIONS, BROWSER_EXTRACT_KINDS, BROWSER_MAX_WAIT_MS, BROWSER_SCROLL_DIRECTIONS, BROWSER_WAIT_STATES } from '@nekko-agent/shared';

/**
 * The built-in agent toolset. These specs are sent to the model; the actual
 * execution lives in the host (Electron main) so that filesystem/shell access
 * passes through the sandbox + guardrails layer.
 */
export const BUILTIN_TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file at an absolute or chat-project-relative path. Large files are truncated; use start_line and end_line (1-based, inclusive) to read later sections with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Omit to read from the beginning.' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to read (inclusive). Defaults to 200 lines from start_line.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique).' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern within the chat project or an explicit directory.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'e.g. src/**/*.ts' }, path: { type: 'string', description: 'Optional directory. Defaults to the chat project.' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional file or directory to scope the search. Defaults to the chat project.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a command in the chat project and wait for it. Windows uses cmd.exe, not Bash or PowerShell; wrap PowerShell commands with powershell -NoProfile -Command. Unix uses /bin/sh. Subject to guardrails, risky commands require user approval. Killed after 120 seconds: for a dev server, a watcher, or anything that keeps running, use start_process instead of backgrounding it yourself.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Optional working directory.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'start_process',
    description:
      'Start a long-running command (a dev server, a watcher, a long build) in the background and return at once with its id. Same shell and guardrails as bash. Its output is buffered: call read_process to see it, kill_process to stop it. Processes stop with the chat.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Optional working directory.' },
        name: { type: 'string', description: 'A short label, e.g. "vite".' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_process',
    description:
      'Output of a background process since you last read it, and whether it is still running. With wait_ms, wait up to that long (max 120000) for new output or exit before answering. Without an id, list this chat\'s processes.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id start_process returned.' },
        wait_ms: { type: 'number', description: 'Wait this long for new output when there is none yet.' },
        all: { type: 'boolean', description: 'Return everything kept, not just what is new.' },
      },
    },
  },
  {
    name: 'kill_process',
    description: 'Stop a background process started with start_process.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a public http(s) URL and return its readable text: HTML is reduced to text with headings, lists and links kept, JSON and plain text come back as they are. One GET, 30 s, 2 MB, up to max_chars characters (default 20000). No scripts, logins or searches: use the browser tool for pages that need a real browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'number', description: 'Characters of text to return (1000 to 100000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser',
    description: 'Control a local Chromium browser. Dedicated mode (use this by default) drives an isolated, hidden in-app Nekko browser with Playwright; it never takes focus. Set visible=true only when the user needs to see the window; it shows without activation. Existing mode attaches only to an explicitly started localhost CDP port and supports navigate, inspect, click, fill and close. Each action requires approval unless the user has enabled allow-all (YOLO) for this chat. Start with navigate or inspect, then use CSS selectors. Dedicated-only actions: wait (selector or text to reach a state), type (keyboard text, into selector or the focused element), press (a key such as Enter or Control+A), scroll (direction and amount, or a selector into view), extract (what=text of a selector, or what=links), evaluate (a JavaScript expression in the page; the JSON result is returned, keep it read-only), screenshot (attaches the page pixels to this chat, requires vision support), tabs, tab_new, tab_switch, tab_close, logs (console messages, page errors and failed requests since the last logs call), and snapshot (a compact list of the page\'s interactive elements, each with a ref such as @e1; optional selector to snapshot part of the page). A ref works as the selector for click, fill, type, press, wait and extract, and is usually the quickest way to act on a page you have not seen: snapshot, then act on refs. Refs expire when the page changes; take a new snapshot. Only HTTP(S) pages; downloads, popups, dialogs and device permissions are blocked. No cloud browser is used.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['dedicated', 'existing'] },
        action: { type: 'string', enum: [...BROWSER_ACTIONS] },
        url: { type: 'string', description: 'HTTP(S) destination for navigate, or optionally for tab_new.' },
        port: { type: 'number', description: 'Existing Chromium localhost CDP port, commonly 9222.' },
        selector: { type: 'string', description: 'CSS selector (the first match is used) for click, fill, wait, type, press, scroll, extract and snapshot, or a ref from snapshot such as @e3 (not for scroll or snapshot).' },
        value: { type: 'string', description: 'Text to enter for fill.' },
        text: { type: 'string', description: 'Text to type for type, or visible text to wait for with wait.' },
        key: { type: 'string', description: 'Key for press, for example Enter, Tab, Escape, ArrowDown or Control+A.' },
        state: { type: 'string', enum: [...BROWSER_WAIT_STATES], description: 'State wait waits for; visible by default.' },
        timeout_ms: { type: 'number', description: `Longest wait in milliseconds for wait (default 5000, at most ${BROWSER_MAX_WAIT_MS}).` },
        direction: { type: 'string', enum: [...BROWSER_SCROLL_DIRECTIONS], description: 'Scroll direction; down by default.' },
        amount: { type: 'number', description: 'Pixels to scroll; 600 by default.' },
        what: { type: 'string', enum: [...BROWSER_EXTRACT_KINDS], description: 'extract: text (innerText of selector, or the page) or links (label and URL, within selector if given).' },
        expression: { type: 'string', description: 'JavaScript expression for evaluate, for example document.querySelectorAll("li").length.' },
        tab: { type: 'number', description: 'Tab index from the tabs action, for tab_switch and tab_close.' },
        visible: { type: 'boolean', description: 'Dedicated mode only: true shows without activation, false hides, omitted keeps current visibility. New windows start hidden.' },
      },
      required: ['mode', 'action'],
    },
  },
  {
    name: 'capture',
    description: 'Capture an actual local app window, including apps launched by terminal commands in any project. Desktop only; each action requires approval unless the user has enabled allow-all (YOLO) for this chat. First list windows, then select its window_id for a PNG screenshot or a 1–15 second silent WebM recording. No browser substitution or whole-screen capture. Prefer native capture for app evidence. Capture never focuses, raises, or restores windows. Hidden/minimized/protected third-party windows depend on OS support; report unavailable frames instead of interrupting the user. List includes the hidden dedicated browser owned by this chat, whose PNG is page content only, without native OS chrome. Output files must be new paths inside the chat project; PNG pixels go to the selected model by default (requires vision support, 5 MB maximum); inspect=false saves locally only. Approval names this disclosure. Recordings are saved only and are not inspected automatically. Report the path and inspect actual evidence before claiming visual verification; never silently switch models.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'screenshot', 'record'] },
        window_id: { type: 'string', description: 'Exact id returned by list for the desired app window.' },
        path: { type: 'string', description: 'New workspace-relative output path ending in .png or .webm.' },
        seconds: { type: 'number', description: 'Recording duration, 1–15 seconds; default 5.' },
        inspect: { type: 'boolean', description: 'Screenshots only: send pixels to the selected model (default true). False saves locally without sending pixels.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'delegation_targets',
    description: 'Discover exact available chat-model IDs on one enabled configured provider before explicit delegation. Read-only; does not create a child, download models, or switch providers. Omit provider_id to inspect the current provider.',
    parameters: {
      type: 'object',
      properties: { provider_id: { type: 'string', description: 'Exact enabled provider ID from routing guidance.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_agent',
    description:
      'Delegate a self-contained sub-task to a fresh sub-agent that works in the same project with its own context, then returns its final answer. Use for parallelizable or well-scoped work (e.g. "investigate X", "implement Y in file Z"). The sub-agent appears as a nested tab in the workbench.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the sub-agent tab.' },
        task: { type: 'string', description: 'The full, standalone instruction for the sub-agent.' },
        provider_id: { type: 'string', description: 'Optional enabled provider ID from the routing guidance. Defaults to the parent provider. Changing provider requires an explicit model_id.' },
        model_id: { type: 'string', description: 'Optional exact model ID known to belong to the target provider; never guess. Defaults to the parent model only when keeping the parent provider. The target is validated and failures never fall back to another model or provider.' },
      },
      required: ['task'],
    },
  },
];

/**
 * Ask before building the wrong thing.
 *
 * Offered only where there is a person to answer: a chat the user is actually
 * in. Sub-agents, automations and goal runs never get it, because a question
 * nobody is there to read is a run that hangs until it is killed.
 *
 * The description is written to be hard to over-use. Agents reach for a
 * clarifying question as a way of not starting, which is worse than a wrong
 * guess you can correct, so it names the narrow cases where asking beats
 * reading the code and says plainly to do the work otherwise.
 */
export const ASK_USER_TOOL: ToolSpec = {
  name: 'ask_user',
  description:
    'Stop and ask the user a small number of multiple-choice questions, then continue with their answers. ' +
    'Use this BEFORE doing the work when the request is genuinely ambiguous and the readings lead to materially ' +
    'different results: which of several things they meant, a product or scope decision that is theirs to make, ' +
    'or a choice you cannot recover from cheaply (a schema, a public API, deleting or overwriting something). ' +
    'Do NOT use it for anything you can find out yourself by reading the code, for permission to run a tool ' +
    '(the app already asks), to confirm a plan you are confident in, or to report progress. ' +
    'One round, at most 4 questions, each with 2-5 concrete options written as the real alternatives. ' +
    'If you would be fine picking an option yourself and saying so, do that instead.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'The questions, at most 4, most important first.',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Two or three words naming the decision, e.g. "Auth method".' },
            question: { type: 'string', description: 'The question, in one sentence.' },
            multiSelect: { type: 'boolean', description: 'True when more than one option can be chosen.' },
            options: {
              type: 'array',
              description: '2-5 concrete, mutually distinct answers. Never "yes"/"no" where a real choice exists.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice itself, a few words.' },
                  description: { type: 'string', description: 'What picking it means, one line.' },
                },
                required: ['label'],
              },
            },
          },
          required: ['header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
};

/**
 * Extra tool offered only to sessions driven by a training/goal run: the agent
 * registers every attempt so the run's experiment tree (idea maze), stats, and
 * leader stay live in the Training/Goals tabs. Executed in the host.
 */
export const REPORT_EXPERIMENT_TOOL: ToolSpec = {
  name: 'report_experiment',
  description:
    'Record or update an experiment in this run\'s experiment tree. Call it when you START an attempt (status "running") and again when it finishes ("succeeded", "failed", or "repaired" if you fixed a failure), including the score when measured. Use parent_id to branch from the experiment you are iterating on. The tool result tells you the current leader.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Experiment id to update (omit to create a new one).' },
      parent_id: { type: 'string', description: 'Id of the experiment this one branches from.' },
      title: { type: 'string', description: 'Short pipeline-style title, e.g. "RobustScaler PCA RandomForest".' },
      approach: { type: 'string', description: 'The idea family, e.g. "gradient boosting", "feature engineering".' },
      status: { type: 'string', enum: ['planned', 'running', 'succeeded', 'failed', 'repaired'] },
      score: { type: 'number', description: 'Primary metric value when measured.' },
      metric: { type: 'string', description: 'Metric name, e.g. "cv r2", "accuracy".' },
      note: { type: 'string', description: 'One-line takeaway from this experiment.' },
    },
    required: ['title', 'status'],
  },
};

/**
 * The plan the agent is actually working to, kept live for the user. Offered
 * to every session: goal runs treat it as the execution contract (the Goals
 * dashboard renders it), ordinary chats show it in the plan rail so the user
 * can watch what the agent decided to do after reading the request. Executed
 * in the host.
 */
export const UPDATE_PLAN_TOOL: ToolSpec = {
  name: 'update_plan',
  description:
    'Publish the plan you are working to. Call it with replace=true and the full ordered step list to write the initial plan (AFTER you have read the request and looked at what it touches, BEFORE execution work) or to re-plan. Without replace, steps are upserted by id: mark the step you are working "active", mark it "done" the moment it is verifiably complete (add a one-line note), or "skipped" with the reason. Keep the plan current; the tool result echoes the plan so you know each step\'s id.',
  parameters: {
    type: 'object',
    properties: {
      replace: { type: 'boolean', description: 'Replace unfinished scope with `steps`, preserving done/skipped history. For later requests, upsert existing steps and append only genuinely new work.' },
      steps: {
        type: 'array',
        description: 'Plan steps, in execution order when replace=true.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Step id to update (omit to create a new step).' },
            title: { type: 'string', description: 'Concrete, verifiable step, e.g. "Wire the CSV parser + unit tests".' },
            status: { type: 'string', enum: ['pending', 'active', 'done', 'skipped'] },
            note: { type: 'string', description: 'One-line outcome, blocker, or skip reason.' },
          },
          required: ['title'],
        },
      },
    },
    required: ['steps'],
  },
};

/**
 * Extra tool offered only to run-driven sessions: register a concrete artifact
 * the run produced (the trained model, a harness file, a report). Drives the
 * "Artifacts" card on the run dashboard so the user can see exactly what was
 * built, where it lives, and how to use it. Call it as soon as an artifact
 * exists on disk, and again to update its note. Executed in the host.
 */
export const REPORT_ARTIFACT_TOOL: ToolSpec = {
  name: 'report_artifact',
  description:
    'Register a concrete artifact this run produced so it shows on the run dashboard. Call it the moment an artifact exists on disk (the trained model, an AGENTS.md / SKILL.md / SPEC.md harness file, a dataset card, an evaluation report). Give the path relative to the workspace. Call again with the same path to update its note. This is how the user sees what the run actually built.',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['model', 'agents-md', 'skill', 'spec', 'dataset', 'code', 'report', 'other'],
        description: 'What the artifact is. Use "model" for the trained model itself.',
      },
      title: { type: 'string', description: 'Short label, e.g. "Trained model (transformer)" or "AGENTS.md".' },
      path: { type: 'string', description: 'Where it lives, relative to the workspace (or absolute), e.g. "nekko-training/ticket-urgency/model_output".' },
      note: { type: 'string', description: 'One line on what it is and how to use it.' },
    },
    required: ['kind', 'title', 'path'],
  },
};

/**
 * Ask a decision model (Laya locally, or TypeSafe Jev) typed questions about a
 * state. Offered only while one is available. It answers in one pass with
 * calibrated probabilities, so it is cheaper and steadier than reasoning a
 * classification out in prose: routing, triage, "is this risky", scoring.
 */
export const DECIDE_TOOL: ToolSpec = {
  name: 'decide',
  description:
    'Classify or score a piece of text or JSON with a dedicated decision model, which returns calibrated probabilities ' +
    'in well under a second. Use it for routing and triage ("which team owns this ticket"), yes/no judgements ' +
    '("does this message ask for a refund"), and ordinal scores ("how urgent"), especially over many items or when you ' +
    'want a probability rather than your own guess. Every question needs an id, a type and instructions: ' +
    '"choice" picks one of options; "score" places the state on options ordered lowest first; "noul" gives the ' +
    'probability that the instructions (a statement) are true and takes no options. Up to 64 questions per call. ' +
    'Example: {"state": "...", "questions": [{"id": "team", "type": "choice", "instructions": "Which team should handle this?", ' +
    '"options": ["billing", "technical", "account"]}, {"id": "refund", "type": "noul", "instructions": "The customer asks for money back."}]}',
  parameters: {
    type: 'object',
    properties: {
      state: { type: 'string', description: 'The text (or JSON as a string) the questions are about. Under 50,000 characters.' },
      questions: {
        type: 'array',
        description: 'The questions to answer about the state.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short name for the answer, e.g. "team".' },
            type: { type: 'string', enum: ['choice', 'score', 'noul'] },
            instructions: { type: 'string', description: 'The question (choice, score) or the statement to judge (noul).' },
            options: { type: 'array', items: { type: 'string' }, description: 'choice: the labels. score: the levels, lowest first. Omit for noul.' },
          },
          required: ['id', 'type', 'instructions'],
        },
      },
    },
    required: ['state', 'questions'],
  },
};

/**
 * The tool's flat question list as the decision API's named questions. Models
 * fill a list of uniform objects far more reliably than a map of maps, so the
 * tool asks for that and this does the reshaping.
 */
type DecideCriteria = string[] | Record<string, string>;

export function decideRequestFromTool(input: unknown): { state: string; questions: Record<string, { type: 'choice' | 'score' | 'noul'; instructions: string; criteria?: DecideCriteria }> } {
  const i = (input ?? {}) as { state?: unknown; questions?: unknown };
  const state = typeof i.state === 'string' ? i.state : JSON.stringify(i.state ?? '');
  const list = Array.isArray(i.questions) ? i.questions : [];
  const questions: Record<string, { type: 'choice' | 'score' | 'noul'; instructions: string; criteria?: DecideCriteria }> = {};
  list.forEach((q, n) => {
    const item = (q ?? {}) as { id?: unknown; type?: unknown; instructions?: unknown; question?: unknown; options?: unknown; criteria?: unknown };
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `q${n + 1}`;
    const type = item.type === 'choice' || item.type === 'score' || item.type === 'noul' ? item.type : 'noul';
    const instructions = typeof item.instructions === 'string' ? item.instructions : typeof item.question === 'string' ? item.question : '';
    const raw = Array.isArray(item.options) ? item.options : Array.isArray(item.criteria) ? item.criteria : undefined;
    // Models also send options as {label, description}; a described choice
    // keeps its descriptions (the model reads them), a score keeps its order.
    const labelOf = (o: unknown) => typeof o === 'object' && o !== null
      ? String((o as Record<string, unknown>).label ?? (o as Record<string, unknown>).name ?? (o as Record<string, unknown>).value ?? '')
      : String(o ?? '');
    const descOf = (o: unknown) => typeof o === 'object' && o !== null ? (o as Record<string, unknown>).description : undefined;
    const labels = raw?.map(labelOf).filter(Boolean);
    const described = type === 'choice' && raw?.some((o) => typeof descOf(o) === 'string');
    const criteria: DecideCriteria | undefined = !labels?.length || type === 'noul'
      ? undefined
      : described
        ? Object.fromEntries(raw!.map((o) => [labelOf(o), typeof descOf(o) === 'string' ? (descOf(o) as string) : labelOf(o)]).filter(([k]) => k))
        : labels;
    questions[id] = { type, instructions, ...(criteria ? { criteria } : {}) };
  });
  return { state, questions };
}
