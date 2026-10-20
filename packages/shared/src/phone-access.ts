/**
 * What a paired phone may do on this computer, enforced by the computer.
 *
 * This is the single source of truth for the computer's relay agent: the
 * engine daemon's gate (crates/nekko-remote/src/phone.rs) reads these lists
 * from `crates/nekko-remote/src/phone-access.json`, which
 * phone-access.golden.test.ts writes from this file and fails on when stale
 * (UPDATE_GOLDEN=1 rewrites it). `tests/golden/phone.json` there records the
 * decisions the gate must make.
 *
 * The policy is an allowlist: a channel that is not listed is refused. A
 * phone's own app lock is not a boundary; this is.
 */

import { clientMessageIdOf } from './chat.js';
import { skillTurnText } from './skills.js';
import { phoneChangesView, PHONE_CHANGES_VIEW } from './phone-changes.js';
import {
  PHONE_LIMIT_WINDOW_VIEW,
  PHONE_LIMITS_VIEW,
  PHONE_PR_VIEW,
  PHONE_PROMPT_VIEW,
  PHONE_QUEUE_EDIT_KEYS,
  PHONE_TASK_VIEW,
  PHONE_VIEWS,
  PHONE_WORKFLOW_RUN_VIEW,
  PHONE_WORKFLOW_VIEW,
  phoneLimitsKey,
  phoneLimitsView,
  phonePromptsView,
  phonePrsView,
  phoneQueueView,
  phoneTasksView,
  phoneUsageView,
  phoneWorkflowsView,
} from './phone-views.js';

/**
 * Channels a paired phone may call. Built from what the phone clients send
 * (apps/mobile/src/lib/protocol.ts, apps/android/protocol Wire.kt `Channels`,
 * apps/ios/Protocol Wire.swift `Channels`), plus the ones the next phone
 * releases need: settings (filtered), completing or deleting a chat the way
 * the desktop does (`session:setOptions` with `archivedAt`, `session:delete`)
 * and voice input. `changes:list` is read only, through `phoneChangesView`, and
 * only when the computer's `phoneChanges` setting is on. Beyond the chat
 * (2026-10-19) the phone is a remote for the agent: it edits its own queue,
 * forks a chat, reads a chat's pull requests, the computer's automations and
 * its usage and limits through narrow views (phone-views.ts), and starts an
 * automation the owner already set up (`task:runNow`, `workflow:run`). Git
 * happens through the agent (a prompt, so approvals apply), never a raw channel.
 */
export const PHONE_CHANNELS = [
  'app:info',
  'changes:list',
  'chat:abort',
  'chat:answer',
  'chat:editQueued',
  'chat:pending',
  'chat:queue',
  'chat:send',
  'limits:get',
  'models:list',
  'pr:sessionList',
  'providers:list',
  'session:create',
  'session:delete',
  'session:fork',
  'session:get',
  'session:setOptions',
  'sessions:summaries',
  'settings:get',
  'settings:update',
  'skills:runnable',
  'task:runNow',
  'tasks:list',
  'tool:approve',
  'usage:summary',
  'voice:status',
  'voice:transcribe',
  'workflow:run',
  'workflows:list',
  'workspace:list',
] as const;

/**
 * Refused from a phone even if someone adds them to `PHONE_CHANNELS` (a test
 * holds the two apart): destructive, credential, remote-access, shell, file
 * write, folder, install and server-management channels.
 */
export const PHONE_ALWAYS_DENIED = {
  channels: [
    'attachment:import',
    // Changing files, or reading any file: never from a phone (the Changes view is read only).
    'changes:accept',
    'changes:acceptAll',
    // Pull request actions and diffs: git happens through the agent (a prompt), so its approvals apply.
    'pr:action',
    'pr:continueStack',
    'pr:diff',
    'pr:linkStack',
    'connector:connect',
    'connector:disconnect',
    'data:wipe',
    'dir:list',
    'file:read',
    'file:write',
    // Makes this computer fetch an arbitrary URL; a phone shows remote images itself.
    'image:fetch',
    'providers:importCliAuth',
    'providers:remove',
    'providers:save',
    'settings:reset',
    // Making, changing or deleting automations stays on the computer; a phone may run one.
    'task:create',
    'task:delete',
    'task:update',
    'voice:cancel',
    'voice:install',
    'voice:permission',
    'voice:uninstall',
    'workflow:cancel',
    'workflow:create',
    'workflow:delete',
    'workflow:duplicate',
    'workflow:event',
    'workflow:update',
    'workspace:addByPath',
    'workspace:gitStatus',
    'workspace:remove',
  ],
  /** Whole families: remote access, terminals, MCP servers, OAuth sign-in, and the desktop's native dialogs, OS shell and updater. */
  prefixes: ['dialog:', 'mcp:', 'oauth:', 'remote:', 'shell:', 'terminal:', 'terminals:', 'update:'],
  /** Not forced off by a prefix (it still has to be in `PHONE_CHANNELS` to be callable). */
  except: ['remote:status'],
};

/**
 * The settings a phone may change with `settings:update`, as dotted paths
 * (`voice.language` is `AppSettings.voice.language`). Anything else in the
 * patch refuses the whole update: nothing is applied.
 */
export const PHONE_SETTINGS_KEYS = [
  'chatPaneAction',
  'defaultChatMode',
  'skipDeleteConfirmation',
  'voice.enabled',
  'voice.language',
] as const;

/**
 * The settings a phone receives from `settings:get` and `settings:update`:
 * what the phone apps read (default model, starred models, the desktop's
 * look) and what they may change. No provider records, keys, tokens, hooks,
 * paths or instructions leave the computer this way.
 */
export const PHONE_SETTINGS_VIEW = [
  'accent',
  'accent2',
  // Whether the computer's automations are paused (read only; set on the computer).
  'automationsPaused',
  'chatPaneAction',
  'defaultChatMode',
  'defaultModelId',
  'defaultProviderId',
  'favoriteModels',
  // Whether this computer shows phones the agent's changes (set on the computer only).
  'phoneChanges',
  // The saved prompts, as names and text (`PHONE_PROMPT_VIEW`).
  'prompts',
  'skipDeleteConfirmation',
  'theme',
  'themePreset',
  'voice.enabled',
  'voice.language',
] as const;

/** The provider fields a phone receives from `providers:list` (never `apiKey`, `tokenKey` or `baseUrl`). */
export const PHONE_PROVIDER_VIEW = ['enabled', 'id', 'kind', 'label'] as const;

/**
 * Chat options a phone may set with `session:setOptions`: the model, the
 * title and organisation, completing (`archivedAt`) and the chat mode. Not the tools, the execution mode, Git
 * isolation or offline/incognito.
 */
export const PHONE_SESSION_OPTION_KEYS = [
  'archivedAt',
  'mode',
  'modelId',
  'pinned',
  'providerId',
  'tags',
  'thinking',
  'title',
] as const;

/** `chat:send` fields a phone may set: no `attachedPaths` (files on this computer) or history limits. */
export const PHONE_CHAT_SEND_KEYS = [
  'clientMessageId',
  'images',
  'modelId',
  'providerId',
  'regenerate',
  'resume',
  'sessionId',
  'skill',
  'text',
] as const;

/**
 * What a phone receives of each runnable skill (`skills:runnable`): enough for
 * its `/` menu. Never the template, which holds the skill's instructions and,
 * for skills imported from other tools, folder paths on this computer.
 */
export const PHONE_SKILL_VIEW = ['category', 'description', 'name', 'source'] as const;

/** `chat:queue` payload fields a phone may set (a plain string is text). */
export const PHONE_QUEUE_KEYS = ['clientMessageId', 'images', 'skill', 'text'] as const;

/**
 * Chat modes a phone may choose, for new chats or for one chat. YOLO is
 * included on purpose: the owner decided a paired phone may pick it.
 */
export const PHONE_CHAT_MODES = ['ask', 'guardrails', 'yolo'] as const;

/**
 * How much of a chat a phone receives from `session:get`. A whole session can
 * be far larger than one relay frame (the relay caps frames at 10 MB; a long
 * agent chat measured 9.8 MB raw, 7.6 MB of it screenshots inside tool
 * results), and a frame that is too large never arrives, so the phone waited
 * two minutes for a timeout. The phone shows text and tool steps, never tool
 * images, so it gets:
 * - the newest `messages` messages (older ones are counted in `omittedMessages`);
 * - tool results without their images (counted in `omittedImages`);
 * - tool output and long string tool arguments cut to `textChars`
 *   characters, with `truncated: true` and the original length;
 * - a message's own photos (`images`, the ones a user attached) as small
 *   thumbnails: the relay agent shrinks them first (`thumbSide` px on the long
 *   side, `thumbnailPhoneImages`), then only the newest `images` of them, each
 *   at most `thumbChars` long, are kept. Any other photo becomes `''`, so the
 *   phone still knows how many there were.
 * The computer keeps the whole chat; the desktop is where the full detail lives.
 */
export const PHONE_SESSION_VIEW = { messages: 300, textChars: 4000, images: 40, thumbSide: 384, thumbChars: 96 * 1024 } as const;

/**
 * The largest sealed reply frame the agent sends a phone. The relay drops
 * frames over 10 MB (`maxFrameBytes`, apps/relay-server/src/server.ts) without a word,
 * so a reply above this is replaced by an error the phone can show at once.
 * Under 10 MB to leave room for the relay envelope.
 */
export const PHONE_MAX_FRAME_BYTES = 9 * 1024 * 1024;

/** The error a phone gets instead of a reply too large for the relay. */
export function phoneFrameTooLarge(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `This reply is too large to send to a phone (${mb} MB). Open it on the computer.`;
}

export type PhoneAccessCode = 'channel-denied' | 'setting-denied' | 'option-denied' | 'value-invalid' | 'skill-unknown' | 'turned-off';

/** Why the computer refused a phone's request. The wire carries `message`. */
export class PhoneAccessError extends Error {
  constructor(
    readonly code: PhoneAccessCode,
    readonly detail: string,
  ) {
    super(`Not allowed from a paired phone (${code}): ${detail}`);
    this.name = 'PhoneAccessError';
  }
}

/** Whether `channel` is refused regardless of the allowlist. */
export function phoneAlwaysDenied(channel: string): boolean {
  if (PHONE_ALWAYS_DENIED.except.includes(channel)) return false;
  return PHONE_ALWAYS_DENIED.channels.includes(channel) || PHONE_ALWAYS_DENIED.prefixes.some((p) => channel.startsWith(p));
}

/** Whether a phone may call `channel` at all. */
export function phoneChannelAllowed(channel: string): boolean {
  return !phoneAlwaysDenied(channel) && (PHONE_CHANNELS as readonly string[]).includes(channel);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Copy only `paths` (dotted, one level of nesting) out of `value`. */
function pick(value: unknown, paths: readonly string[]): Obj {
  const out: Obj = {};
  if (!isObj(value)) return out;
  for (const path of paths) {
    const [head, sub] = path.split('.', 2);
    if (!own(value, head)) continue;
    if (sub === undefined) {
      out[head] = value[head];
      continue;
    }
    const inner = value[head];
    if (!isObj(inner) || !own(inner, sub)) continue;
    out[head] = { ...(isObj(out[head]) ? out[head] : {}), [sub]: inner[sub] };
  }
  return out;
}

function chatMode(value: unknown, what: string): void {
  if (typeof value !== 'string') throw new PhoneAccessError('value-invalid', what);
  if (!(PHONE_CHAT_MODES as readonly string[]).includes(value)) throw new PhoneAccessError('value-invalid', what);
}

/** One phone-settable setting's value, or why not. */
function settingValue(path: string, value: unknown): void {
  switch (path) {
    case 'defaultChatMode':
      return chatMode(value, path);
    case 'chatPaneAction':
      if (value === 'complete' || value === 'delete') return;
      break;
    case 'skipDeleteConfirmation':
    case 'voice.enabled':
      if (typeof value === 'boolean') return;
      break;
    case 'voice.language':
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value)) return;
      break;
  }
  throw new PhoneAccessError('value-invalid', path);
}

/**
 * The settings patch a phone sent, checked whole before anything is applied:
 * every key must be phone-settable with a valid value, or the update is
 * refused. Returns the dotted paths it sets, in order.
 */
export function checkPhoneSettingsPatch(patch: unknown): Array<[string, unknown]> {
  if (!isObj(patch)) throw new PhoneAccessError('value-invalid', 'settings patch');
  const sets: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'voice' && isObj(value)) {
      for (const [sub, v] of Object.entries(value)) sets.push([`voice.${sub}`, v]);
    } else sets.push([key, value]);
  }
  for (const [path] of sets) {
    if (!(PHONE_SETTINGS_KEYS as readonly string[]).includes(path)) throw new PhoneAccessError('setting-denied', path);
  }
  for (const [path, value] of sets) settingValue(path, value);
  return sets;
}

/**
 * A phone's call checked against the allowlist and its arguments against the
 * per-channel rules, or a `PhoneAccessError`. A `settings:update` comes back
 * as the checked `settingsPatch`, which `phoneSettingsUpdate` turns into the
 * patch to save.
 */
export function screenPhoneCall(
  channel: string,
  args: unknown[],
): { settingsPatch?: Array<[string, unknown]>; skill?: { name: string; input: string } } {
  if (!phoneChannelAllowed(channel)) throw new PhoneAccessError('channel-denied', channel);
  switch (channel) {
    case 'changes:list':
    case 'pr:sessionList':
      if (typeof args[0] !== 'string' || args[0] === '') throw new PhoneAccessError('value-invalid', 'chat id');
      if (channel === 'pr:sessionList' && args[1] !== undefined && typeof args[1] !== 'boolean') throw new PhoneAccessError('value-invalid', 'refresh');
      return {};
    case 'session:fork':
      if (typeof args[0] !== 'string' || args[0] === '') throw new PhoneAccessError('value-invalid', 'chat id');
      if (args[1] !== undefined && args[1] !== null && (typeof args[1] !== 'string' || args[1] === '')) throw new PhoneAccessError('value-invalid', 'message id');
      return {};
    case 'chat:editQueued': {
      if (typeof args[0] !== 'string' || args[0] === '') throw new PhoneAccessError('value-invalid', 'chat id');
      if (typeof args[1] !== 'number' || !Number.isInteger(args[1]) || args[1] < 0) throw new PhoneAccessError('value-invalid', 'queue index');
      const edit = args[2];
      if (!isObj(edit)) throw new PhoneAccessError('value-invalid', 'queued prompt edit');
      for (const key of Object.keys(edit)) {
        if (!(PHONE_QUEUE_EDIT_KEYS as readonly string[]).includes(key)) throw new PhoneAccessError('option-denied', key);
      }
      if (typeof edit.expect !== 'string' || (own(edit, 'text') && typeof edit.text !== 'string')) {
        throw new PhoneAccessError('value-invalid', 'queued prompt edit');
      }
      return {};
    }
    case 'task:runNow':
    case 'workflow:run':
      if (typeof args[0] !== 'string' || args[0] === '') throw new PhoneAccessError('value-invalid', channel === 'task:runNow' ? 'task id' : 'workflow id');
      return {};
    case 'limits:get':
      if (typeof args[0] !== 'string' || args[0] === '') throw new PhoneAccessError('value-invalid', 'provider id');
      return {};
    case 'settings:update':
      return { settingsPatch: checkPhoneSettingsPatch(args[0]) };
    case 'session:setOptions': {
      const patch = args[1];
      if (!isObj(patch)) throw new PhoneAccessError('value-invalid', 'chat options');
      for (const key of Object.keys(patch)) {
        if (!(PHONE_SESSION_OPTION_KEYS as readonly string[]).includes(key)) throw new PhoneAccessError('option-denied', key);
      }
      if (own(patch, 'mode')) chatMode(patch.mode, 'mode');
      return {};
    }
    case 'chat:send': {
      const opts = args[0];
      if (!isObj(opts)) throw new PhoneAccessError('value-invalid', 'chat:send options');
      for (const key of Object.keys(opts)) {
        if (!(PHONE_CHAT_SEND_KEYS as readonly string[]).includes(key)) throw new PhoneAccessError('option-denied', key);
      }
      phoneClientMessageId(opts);
      return own(opts, 'skill') ? { skill: phoneSkill(opts.skill) } : {};
    }
    case 'chat:queue': {
      const item = args[1];
      if (typeof item === 'string') return {};
      if (!isObj(item)) throw new PhoneAccessError('value-invalid', 'chat:queue prompt');
      for (const key of Object.keys(item)) {
        if (!(PHONE_QUEUE_KEYS as readonly string[]).includes(key)) throw new PhoneAccessError('option-denied', key);
      }
      phoneClientMessageId(item);
      return own(item, 'skill') ? { skill: phoneSkill(item.skill) } : {};
    }
    default:
      return {};
  }
}

/** A phone's `clientMessageId`, when it sent one, must be a short id (a UUID). */
function phoneClientMessageId(o: Obj): void {
  if (own(o, 'clientMessageId') && !clientMessageIdOf(o.clientMessageId)) throw new PhoneAccessError('value-invalid', 'clientMessageId');
}

/** A `{ name, input }` skill invocation from a phone, or why not. */
function phoneSkill(value: unknown): { name: string; input: string } {
  if (!isObj(value) || typeof value.name !== 'string' || !value.name || (value.input !== undefined && typeof value.input !== 'string')) {
    throw new PhoneAccessError('value-invalid', 'skill');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'name' && key !== 'input') throw new PhoneAccessError('value-invalid', 'skill');
  }
  return { name: value.name, input: typeof value.input === 'string' ? value.input : '' };
}

/**
 * A phone's skill turn as the desktop composer sends it: the computer looks
 * the skill up by name in its own runnable list and sends its template plus
 * the user's input, so the template never has to reach the phone. The phone's
 * `text` is replaced; an unknown skill is refused rather than sent bare.
 */
function expandPhoneSkill(
  skill: { name: string; input: string },
  runnable: unknown,
  base: Obj,
): Obj {
  const list = Array.isArray(runnable) ? runnable : [];
  const found = list.find((s) => isObj(s) && s.name === skill.name && typeof s.template === 'string') as Obj | undefined;
  if (!found) throw new PhoneAccessError('skill-unknown', skill.name);
  return { ...base, text: skillTurnText(found.template as string, skill.input), skill };
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The patch to save for checked phone settings, given the current settings.
 * Paths that are not phone-settable are dropped here too, so this never
 * writes a key it was not meant to, whatever it is given.
 */
export function phoneSettingsUpdate(sets: Array<[string, unknown]>, current: unknown): Obj {
  const patch: Obj = {};
  for (const [path, value] of sets) {
    if (!(PHONE_SETTINGS_KEYS as readonly string[]).includes(path)) continue;
    const [head, sub] = path.split('.', 2);
    if (UNSAFE_KEYS.has(head) || (sub !== undefined && UNSAFE_KEYS.has(sub))) continue;
    if (sub === undefined) {
      patch[head] = value;
      continue;
    }
    // `voice` is saved whole (settings merge one level deep), so keep the rest of it.
    if (!isObj(patch[head])) {
      const was = isObj(current) ? current[head] : undefined;
      patch[head] = isObj(was) ? { ...was } : {};
    }
    (patch[head] as Obj)[sub] = value;
  }
  return patch;
}

/** What a phone receives for a channel's result: secrets never leave the computer. */
export function redactPhoneResult(channel: string, result: unknown): unknown {
  switch (channel) {
    case 'settings:get':
    case 'settings:update': {
      const view = pick(result, PHONE_SETTINGS_VIEW);
      if (own(view, 'prompts')) view.prompts = phonePromptsView(view.prompts);
      return view;
    }
    case 'providers:list':
      return Array.isArray(result) ? result.map((p) => pick(p, PHONE_PROVIDER_VIEW)) : [];
    case 'skills:runnable':
      return Array.isArray(result) ? result.map((s) => pick(s, PHONE_SKILL_VIEW)) : [];
    case 'session:get':
      return phoneSessionView(result);
    case 'changes:list':
      return phoneChangesView(result);
    case 'chat:editQueued':
      return isObj(result) ? { id: result.id, queue: phoneQueueView(result.queue) } : null;
    case 'session:fork':
      return isObj(result) ? pick(result, ['id', 'title']) : null;
    case 'tasks:list':
      return phoneTasksView(result);
    case 'workflows:list':
      return phoneWorkflowsView(result);
    case 'workflow:run':
      return isObj(result) ? pick(result, PHONE_WORKFLOW_RUN_VIEW) : null;
    case 'task:runNow':
      return null;
    case 'pr:sessionList':
      return phonePrsView(result);
    case 'usage:summary':
      return phoneUsageView(result);
    case 'limits:get':
      return phoneLimitsView(result);
    default:
      return result;
  }
}

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const end = s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

/** A tool call's input with long string values cut; other values kept. */
function cutInput(input: unknown, n: number): { input: unknown; cut: boolean } {
  if (typeof input === 'string') return input.length > n ? { input: cutText(input, n), cut: true } : { input, cut: false };
  if (!isObj(input)) return { input, cut: false };
  let cut = false;
  const out: Obj = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > n) {
      out[k] = cutText(v, n);
      cut = true;
    } else out[k] = v;
  }
  return { input: out, cut };
}

/** One message as the phone receives it (see `PHONE_SESSION_VIEW`). */
function phoneMessage(m: unknown, n: number): unknown {
  if (!isObj(m)) return m;
  const out: Obj = { ...m };
  if (isObj(m.toolResult)) {
    const r: Obj = { ...m.toolResult };
    if (Array.isArray(r.images)) {
      if (r.images.length) r.omittedImages = r.images.length;
      delete r.images;
    }
    if (typeof r.output === 'string' && r.output.length > n) {
      r.outputChars = r.output.length;
      r.output = cutText(r.output, n);
      r.truncated = true;
    }
    out.toolResult = r;
  }
  if (Array.isArray(m.toolCalls)) {
    out.toolCalls = m.toolCalls.map((c) => {
      if (!isObj(c) || !own(c, 'input')) return c;
      const { input, cut } = cutInput(c.input, n);
      return cut ? { ...c, input, truncated: true } : c;
    });
  }
  return out;
}

/**
 * The session as a phone receives it from `session:get`: the newest messages,
 * tool images dropped and long tool text cut (`PHONE_SESSION_VIEW`). Anything
 * that isn't a session object passes through unchanged.
 */
export function phoneSessionView(session: unknown): unknown {
  if (!isObj(session) || !Array.isArray(session.messages)) return session;
  const all = session.messages;
  const keep = all.slice(Math.max(0, all.length - PHONE_SESSION_VIEW.messages));
  const messages = keep.map((m) => phoneMessage(m, PHONE_SESSION_VIEW.textChars));
  // Newest first: the last `images` photos small enough to be thumbnails stay.
  let room: number = PHONE_SESSION_VIEW.images;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || !Array.isArray(m.images)) continue;
    const imgs = m.images.map((v) => (typeof v === 'string' ? v : ''));
    for (let j = imgs.length - 1; j >= 0; j--) {
      const fits = imgs[j] !== '' && imgs[j].length <= PHONE_SESSION_VIEW.thumbChars && room > 0;
      if (fits) room--;
      else imgs[j] = '';
    }
    messages[i] = { ...m, images: imgs };
  }
  const out: Obj = { ...session, messages };
  if (own(session, 'queue')) out.queue = phoneQueueView(session.queue);
  if (all.length > keep.length) out.omittedMessages = all.length - keep.length;
  return out;
}

/** Shrinks one image data URL to a thumbnail, or returns `''` when it can't. */
export type PhoneThumbnailer = (dataUrl: string) => Promise<string>;

/**
 * The newest photos of a `session:get` result as thumbnails (see
 * `PHONE_SESSION_VIEW`), before `phoneSessionView` picks which to keep. Only
 * messages the phone will receive are touched; the computer's copy is not.
 * A photo the thumbnailer can't read becomes `''`.
 */
export async function thumbnailPhoneImages(session: unknown, thumb: PhoneThumbnailer): Promise<unknown> {
  if (!isObj(session) || !Array.isArray(session.messages)) return session;
  const all = session.messages;
  const from = Math.max(0, all.length - PHONE_SESSION_VIEW.messages);
  const messages = all.slice();
  let room: number = PHONE_SESSION_VIEW.images;
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i];
    if (!isObj(m) || !Array.isArray(m.images) || m.images.length === 0) continue;
    const imgs: string[] = [];
    for (let j = m.images.length - 1; j >= 0; j--) {
      const v = m.images[j];
      if (room > 0 && typeof v === 'string' && v) {
        room--;
        imgs[j] = await thumb(v).catch(() => '');
      } else imgs[j] = '';
    }
    messages[i] = { ...m, images: imgs };
  }
  return { ...session, messages };
}

/**
 * Run a phone's request through the policy: refuse it, or call `dispatch`
 * with the checked arguments and return the redacted result.
 */
export async function callFromPhone(
  dispatch: (channel: string, args: unknown[]) => unknown,
  channel: string,
  args: unknown[],
  /** Shrinks a chat's photos for `session:get`; without it they arrive as `''` unless already tiny. */
  thumb?: PhoneThumbnailer,
): Promise<unknown> {
  const { settingsPatch, skill } = screenPhoneCall(channel, args);
  if (channel === 'changes:list') {
    // Off unless the computer's owner turned it on (Settings → Remote access).
    const settings = await dispatch('settings:get', []);
    if (!isObj(settings) || settings.phoneChanges !== true) throw new PhoneAccessError('turned-off', 'changes:list');
  }
  let callArgs = args;
  // Only what the computer's own call takes: an id, or nothing.
  if (channel === 'task:runNow' || channel === 'workflow:run') callArgs = [args[0]];
  if (channel === 'tasks:list' || channel === 'workflows:list' || channel === 'usage:summary') callArgs = [];
  if (channel === 'session:fork') callArgs = args[1] == null ? [args[0]] : [args[0], args[1]];
  if (channel === 'chat:editQueued') callArgs = [args[0], args[1], pick(args[2], PHONE_QUEUE_EDIT_KEYS)];
  if (channel === 'pr:sessionList') callArgs = [args[0], args[1] === true];
  if (channel === 'limits:get') {
    // The phone names a provider; the computer reads that provider's limits key itself.
    const key = phoneLimitsKey(await dispatch('providers:list', []), args[0] as string);
    if (!key) return null;
    callArgs = [key, false];
  }
  if (settingsPatch) {
    const nested = settingsPatch.some(([path]) => path.includes('.'));
    const current = nested ? await dispatch('settings:get', []) : undefined;
    callArgs = [phoneSettingsUpdate(settingsPatch, current)];
  }
  if (skill) {
    const runnable = await dispatch('skills:runnable', []);
    callArgs = channel === 'chat:send'
      ? [expandPhoneSkill(skill, runnable, args[0] as Obj), ...args.slice(1)]
      : [args[0], expandPhoneSkill(skill, runnable, args[1] as Obj), ...args.slice(2)];
  }
  const result = await dispatch(channel, callArgs);
  if (channel === 'session:get' && thumb) return redactPhoneResult(channel, await thumbnailPhoneImages(result, thumb));
  return redactPhoneResult(channel, result);
}

/** The policy as data: what `phone-access.json` holds for the Rust gate. */
export function phoneAccessPolicy() {
  return {
    channels: [...PHONE_CHANNELS],
    alwaysDenied: PHONE_ALWAYS_DENIED,
    settingsKeys: [...PHONE_SETTINGS_KEYS],
    settingsView: [...PHONE_SETTINGS_VIEW],
    providerView: [...PHONE_PROVIDER_VIEW],
    skillView: [...PHONE_SKILL_VIEW],
    queueKeys: [...PHONE_QUEUE_KEYS],
    sessionOptionKeys: [...PHONE_SESSION_OPTION_KEYS],
    chatSendKeys: [...PHONE_CHAT_SEND_KEYS],
    chatModes: [...PHONE_CHAT_MODES],
    sessionView: { ...PHONE_SESSION_VIEW },
    changesView: { ...PHONE_CHANGES_VIEW },
    views: { ...PHONE_VIEWS },
    promptView: [...PHONE_PROMPT_VIEW],
    taskView: [...PHONE_TASK_VIEW],
    workflowView: [...PHONE_WORKFLOW_VIEW],
    workflowRunView: [...PHONE_WORKFLOW_RUN_VIEW],
    prView: [...PHONE_PR_VIEW],
    limitsView: [...PHONE_LIMITS_VIEW],
    limitWindowView: [...PHONE_LIMIT_WINDOW_VIEW],
    queueEditKeys: [...PHONE_QUEUE_EDIT_KEYS],
    maxFrameBytes: PHONE_MAX_FRAME_BYTES,
  };
}
