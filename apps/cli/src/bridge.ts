import { VERSION } from './version.js';

/**
 * The Claude Agent approval bridge: `nekko-agent mcp --bridge --url <nekkod>`, with
 * the chat's bridge token in `NEKKO_BRIDGE_TOKEN` (never in argv, which any local
 * user can list).
 *
 * nekkod starts the user's own Claude Code with `--permission-prompt-tool
 * mcp__nekko_bridge__approve` and a per-chat `--mcp-config` that runs this
 * server. Each permission prompt Claude Code raises becomes one `approve` call,
 * which this server forwards to nekkod (`POST /harness/approve`, authenticated
 * by the chat's bridge token only) and answers with nekkod's decision: the
 * chat's mode, or the user in Nekko's approval UI, on the wall or the phone.
 *
 * Anything that goes wrong (nekkod unreachable, a refused token, a malformed
 * answer) is a deny. Permissions fail closed.
 */

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const APPROVE_TOOL = {
  name: 'approve',
  description:
    "Nekko Agent's permission prompt for Claude Code: decides whether a tool call may run, asking the user in Nekko Agent when the chat's mode says so.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      toolName: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
      toolUseID: { type: 'string' },
    },
  },
};

/**
 * Nekko Agent's durable watch, offered to a Claude Code chat only when nekkod
 * passes `--tools agent_watch`: it does so where the Claude policy allows Nekko
 * tools and unattended wake-ups for the chat's sign-in (an API key or a cloud
 * account; on a Claude plan only with the user's recorded approval). nekkod
 * checks the policy again on every call.
 */
export const WATCH_TOOL = {
  name: 'agent_watch',
  description:
    "Nekko Agent's durable watch: wakes this chat later, even after you end your turn, Claude Code exits, or the app restarts (while Nekko Agent runs). " +
    'Use it before ending a turn that waits on background work you do not control, such as PR checks or a review: kind=pr wakes once when the PR changes (state, checks, review, draft) or at timeout_seconds; kind=timer wakes once after delay_seconds. ' +
    'Do everything that does not depend on the result first (tests, evidence, docs), then arm the watch with a concrete continuation prompt. ' +
    'Report the watch id and wake condition only after it was armed; on wake, check the current state and re-arm if you still need to wait. ' +
    'List or cancel this chat\'s watches with action=list or action=cancel. Never use it to wait out a user decision, a missing permission or credential, or evidence only the user can provide. It grants no new permissions.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] },
      kind: { type: 'string', enum: ['timer', 'pr'] },
      prompt: { type: 'string', description: 'Concrete continuation instruction; no new authority is granted.' },
      url: { type: 'string', description: 'GitHub PR URL for a pr watch.' },
      delay_seconds: { type: 'number', description: 'Timer delay (60 seconds to 7 days); default 300.' },
      timeout_seconds: { type: 'number', description: 'PR maximum wait before waking for a status check (60 seconds to 7 days); default 3600.' },
      id: { type: 'string', description: 'Watch id to cancel, owned by this chat.' },
    },
    required: ['action'],
  },
};

/** In-turn naming only; nekkod checks both capabilities and title ownership. */
export const TITLE_TOOL = {
  name: 'set_chat_title',
  description: 'Give this new chat a short 2-4 word label for what it is for, leading with an issue or PR number when the request names one. Do not copy the opening words of the request. Never overwrite a user-chosen title. This changes only the Nekko chat title, not the Claude Code session name.',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', description: 'A 2-4 word label for what the chat is for.' } },
    required: ['title'],
  },
};

/**
 * The picture tools (#2973), offered when nekkod passes them in `--tools`:
 * only where the Claude policy's `nekko_tools` row is enabled for the chat's
 * sign-in and a picture model is ready on the computer. The same tools as a
 * Nekko engine chat's (crates/nekko-turn/src/catalog.json), except that the
 * picture is kept in Nekko's data folder and named in the answer: Claude
 * Code copies it into the project with its own tools.
 */
const MODEL_FIELD = { type: 'string', description: 'A model id from media_models. Default: the chat\'s picture model, then Settings, then the best ready one.' };
const SIZE_FIELD = { type: 'string', description: 'WIDTHxHEIGHT, each 256 to 2048 in multiples of 64 (e.g. 1024x1024 or 1344x768). Default 1024x1024.' };
export const GENERATE_IMAGE_TOOL = {
  name: 'generate_image',
  description:
    'Make a picture with a local image model on this computer, from a written description. Nothing leaves the computer and it costs nothing, but it can take from seconds to minutes and only one picture or clip runs at a time on this computer. ' +
    'You get the picture back and the path of the PNG Nekko kept; copy it into the project with your own tools if the user wants it there. Describe the subject, style, composition and any text exactly. Do not use it for diagrams or charts you can write as code.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What the picture shows, in detail.' },
      model: MODEL_FIELD,
      size: SIZE_FIELD,
      count: { type: 'number', description: 'How many variations, 1 to 4 (default 1).' },
    },
    required: ['prompt'],
  },
};
export const EDIT_IMAGE_TOOL = {
  name: 'edit_image',
  description:
    'Change an existing picture with a local image model that edits (see media_models): restyle it, add or remove something, change colours. Give pictures from the chat\'s folders, or "last" for the last picture made in this chat. Nothing leaves the computer.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to change, as an instruction.' },
      images: { type: 'array', items: { type: 'string' }, description: '1 to 4 paths (.png, .jpg, .jpeg or .webp) in the chat\'s folders, or ["last"].' },
      model: MODEL_FIELD,
      size: SIZE_FIELD,
    },
    required: ['prompt', 'images'],
  },
};
export const MEDIA_MODELS_TOOL = {
  name: 'media_models',
  description: 'List the picture models this chat can use on this computer: id, name and what each can do (create, edit).',
  inputSchema: { type: 'object', properties: {} },
};

/**
 * A short clip (#2973), offered only where the Claude policy allows both
 * Nekko tools and unattended runs (the clip wakes the chat when it is ready)
 * and a video model is ready. It answers at once; the clip is kept in Nekko's data folder.
 */
export const GENERATE_VIDEO_TOOL = {
  name: 'generate_video',
  description:
    'Start a short clip (about two seconds, an animated WebP) with a local video model on this computer (experimental), from a written description and optionally a first frame. ' +
    'A clip takes minutes, so this returns at once: end your turn after telling the user, and this chat wakes with the path of the clip Nekko kept when it is ready (or why it failed). Copy it into the project with your own tools if the user wants it there. Nothing leaves the computer.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What happens in the clip, in detail: subject, motion, camera, style.' },
      image: { type: 'string', description: 'Optional first frame: a picture in the chat\'s folders, or "last" for the last picture made in this chat.' },
      model: { type: 'string', description: 'A video model id. Default: the first ready one.' },
      size: { type: 'string', description: 'The clip\'s shape as WIDTHxHEIGHT (e.g. 832x480 or 480x832), scaled to about 832x480 pixels.' },
      then: { type: 'string', description: 'What to do when the clip is ready, as an instruction to yourself.' },
    },
    required: ['prompt'],
  },
};

type NekkoTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** The Nekko tools a bridge may be told to offer, by name. */
const NEKKO_TOOLS: Record<string, NekkoTool> = Object.fromEntries(
  [WATCH_TOOL, TITLE_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL, MEDIA_MODELS_TOOL, GENERATE_VIDEO_TOOL].map((t) => [t.name, t]),
);

/** `--tools a,b`: the known Nekko tools nekkod asked this bridge to offer. */
export function offeredTools(flag: string | undefined): NekkoTool[] {
  const names = (flag ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)].flatMap((n) => (n in NEKKO_TOOLS ? [NEKKO_TOOLS[n]!] : []));
}

/** A tool's answer; `images` are base64 PNGs (the picture tools). */
export type ToolAnswer = { ok: true; text: string; images?: string[] } | { ok: false; error: string };

/** Run one Nekko tool through nekkod. Never throws: a failure is an error result. */
export async function callNekkod(
  url: string,
  token: string,
  call: { name: string; input: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<ToolAnswer> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/harness/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(call),
    });
    if (!res.ok) return { ok: false, error: `Nekko Agent refused the tool call (HTTP ${res.status}).` };
    const answer = (await res.json()) as { ok?: unknown; text?: unknown; error?: unknown; images?: unknown };
    if (answer.ok === true && typeof answer.text === 'string') {
      const images = Array.isArray(answer.images) ? answer.images.filter((i): i is string => typeof i === 'string' && i.length > 0) : [];
      return images.length ? { ok: true, text: answer.text, images } : { ok: true, text: answer.text };
    }
    return { ok: false, error: typeof answer.error === 'string' ? answer.error : 'Nekko Agent gave no usable answer.' };
  } catch (e) {
    return { ok: false, error: `Could not reach Nekko Agent (${(e as Error).message}).` };
  }
}

export type BridgeDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

const deny = (message: string): BridgeDecision => ({ behavior: 'deny', message });

/** Ask nekkod about one permission prompt. Never throws: a failure is a deny. */
export async function askNekkod(
  url: string,
  token: string,
  prompt: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeDecision> {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/harness/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(prompt),
    });
    if (!res.ok) return deny(`Nekko Agent refused the approval request (HTTP ${res.status}).`);
    const answer = (await res.json()) as Partial<BridgeDecision> & { updatedInput?: unknown; message?: unknown };
    if (answer.behavior === 'allow' && answer.updatedInput && typeof answer.updatedInput === 'object') {
      return { behavior: 'allow', updatedInput: answer.updatedInput as Record<string, unknown> };
    }
    if (answer.behavior === 'deny') return deny(typeof answer.message === 'string' ? answer.message : 'Denied.');
    return deny('Nekko Agent gave no usable answer, so this was denied.');
  } catch (e) {
    return deny(`Could not reach Nekko Agent to approve this (${(e as Error).message}), so it was denied.`);
  }
}

/** One JSON-RPC message in, its reply (or nothing, for a notification). */
export async function handleBridgeMessage(
  msg: { id?: unknown; method?: string; params?: any },
  ask: (prompt: Record<string, unknown>) => Promise<BridgeDecision>,
  tools: NekkoTool[] = [],
  run: (call: { name: string; input: Record<string, unknown> }) => Promise<ToolAnswer> = async () => ({ ok: false, error: 'Not offered.' }),
): Promise<unknown | undefined> {
  const { id, method, params } = msg;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'nekko_bridge', title: 'Nekko Agent approvals', version: VERSION } });
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: [APPROVE_TOOL, ...tools] });
  if (method === 'tools/call' && tools.some((t) => t.name === params?.name)) {
    const input = params?.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    const answer = await run({ name: String(params.name), input });
    if (!answer.ok) return ok({ content: [{ type: 'text', text: answer.error }], isError: true });
    const pictures = (answer.images ?? []).map((data) => ({ type: 'image', data, mimeType: 'image/png' }));
    return ok({ content: [{ type: 'text', text: answer.text }, ...pictures] });
  }
  if (method === 'tools/call') {
    const decision =
      params?.name === APPROVE_TOOL.name
        ? await ask((params?.arguments ?? {}) as Record<string, unknown>)
        : deny(`Unknown tool: ${String(params?.name)}`);
    return ok({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  if (id === undefined) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

export function runBridgeServer(opts: { token?: string; url?: string; tools?: string }): void {
  console.log = (...a: unknown[]) => console.error(...a);
  const { token, url } = opts;
  const ask = (prompt: Record<string, unknown>) =>
    token && url ? askNekkod(url, token, prompt) : Promise.resolve(deny('The approval bridge was started without its token or address.'));
  const tools = token && url ? offeredTools(opts.tools) : [];
  const run = (call: { name: string; input: Record<string, unknown> }) =>
    token && url ? callNekkod(url, token, call) : Promise.resolve<ToolAnswer>({ ok: false, error: 'The bridge was started without its token or address.' });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handleBridgeMessage(msg, ask, tools, run).then((reply) => reply !== undefined && send(reply));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
