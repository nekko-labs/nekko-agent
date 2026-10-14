/**
 * What a paired phone may do on this computer, enforced by the computer.
 *
 * This is the single source of truth for both relay agents: the TS one
 * (packages/host/src/relay.ts) applies it directly, and the engine daemon's
 * (crates/nekko-remote/src/phone.rs) reads the same lists from
 * `crates/nekko-remote/src/phone-access.json`, which
 * packages/host/src/remote.golden.test.ts writes from this file and fails on
 * when stale (UPDATE_GOLDEN=1 rewrites it). The same test records decisions
 * the Rust gate must reproduce exactly (`tests/golden/phone.json`).
 *
 * The policy is an allowlist: a channel that is not listed is refused. A
 * phone's own app lock is not a boundary; this is.
 */

/**
 * Channels a paired phone may call. Built from what the phone clients send
 * (apps/mobile/src/lib/protocol.ts, apps/android/protocol Wire.kt `Channels`,
 * apps/ios/Protocol HostProtocol.swift), plus the ones the next phone
 * releases need: settings (filtered), completing or deleting a chat the way
 * the desktop does (`session:setOptions` with `archivedAt`, `session:delete`)
 * and voice input.
 */
export const PHONE_CHANNELS = [
  'app:info',
  'chat:abort',
  'chat:answer',
  'chat:pending',
  'chat:queue',
  'chat:send',
  'models:list',
  'providers:list',
  'session:create',
  'session:delete',
  'session:get',
  'session:setOptions',
  'sessions:summaries',
  'settings:get',
  'settings:update',
  'tool:approve',
  'voice:status',
  'voice:transcribe',
  'workspace:list',
] as const;

/**
 * Refused from a phone even if someone adds them to `PHONE_CHANNELS` (a test
 * holds the two apart): destructive, credential, remote-access, shell, file
 * write, folder, install and server-management channels.
 */
export const PHONE_ALWAYS_DENIED = {
  channels: [
    'connector:connect',
    'connector:disconnect',
    'data:wipe',
    'file:write',
    'providers:importCliAuth',
    'providers:remove',
    'providers:save',
    'settings:reset',
    'voice:cancel',
    'voice:install',
    'voice:uninstall',
    'workspace:addByPath',
    'workspace:remove',
  ],
  /** Whole families: remote access, terminals, MCP servers, OAuth sign-in. */
  prefixes: ['mcp:', 'oauth:', 'remote:', 'terminal:', 'terminals:'],
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
  'chatPaneAction',
  'defaultChatMode',
  'defaultModelId',
  'defaultProviderId',
  'favoriteModels',
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
 * title and organisation, completing (`archivedAt`) and the chat mode, which
 * goes through `phoneChatModeAllowed`. Not the tools, the execution mode, Git
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
  'images',
  'modelId',
  'providerId',
  'regenerate',
  'resume',
  'sessionId',
  'skill',
  'text',
] as const;

/** Chat modes a phone may choose, for new chats or for one chat. */
export const PHONE_CHAT_MODES = ['ask', 'guardrails'] as const;

/**
 * The open policy decision, kept in one place: may a phone switch a chat (or
 * the default for new chats) to YOLO? Until the owner decides between "never"
 * and "only after confirming on the computer", it may not. Replace this check
 * with the confirmation flow once decided; its Rust twin is
 * `phone::chat_mode_allowed`.
 */
export const PHONE_YOLO_MODE = 'yolo';
export function phoneChatModeAllowed(mode: string): boolean {
  return mode !== PHONE_YOLO_MODE;
}

export type PhoneAccessCode = 'channel-denied' | 'setting-denied' | 'option-denied' | 'value-invalid' | 'yolo-denied';

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
  if (!phoneChatModeAllowed(value)) throw new PhoneAccessError('yolo-denied', what);
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
export function screenPhoneCall(channel: string, args: unknown[]): { settingsPatch?: Array<[string, unknown]> } {
  if (!phoneChannelAllowed(channel)) throw new PhoneAccessError('channel-denied', channel);
  switch (channel) {
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
      return {};
    }
    default:
      return {};
  }
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
    case 'settings:update':
      return pick(result, PHONE_SETTINGS_VIEW);
    case 'providers:list':
      return Array.isArray(result) ? result.map((p) => pick(p, PHONE_PROVIDER_VIEW)) : [];
    default:
      return result;
  }
}

/**
 * Run a phone's request through the policy: refuse it, or call `dispatch`
 * with the checked arguments and return the redacted result.
 */
export async function callFromPhone(
  dispatch: (channel: string, args: unknown[]) => unknown,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const { settingsPatch } = screenPhoneCall(channel, args);
  let callArgs = args;
  if (settingsPatch) {
    const nested = settingsPatch.some(([path]) => path.includes('.'));
    const current = nested ? await dispatch('settings:get', []) : undefined;
    callArgs = [phoneSettingsUpdate(settingsPatch, current)];
  }
  return redactPhoneResult(channel, await dispatch(channel, callArgs));
}

/** The policy as data: what `phone-access.json` holds for the Rust gate. */
export function phoneAccessPolicy() {
  return {
    channels: [...PHONE_CHANNELS],
    alwaysDenied: PHONE_ALWAYS_DENIED,
    settingsKeys: [...PHONE_SETTINGS_KEYS],
    settingsView: [...PHONE_SETTINGS_VIEW],
    providerView: [...PHONE_PROVIDER_VIEW],
    sessionOptionKeys: [...PHONE_SESSION_OPTION_KEYS],
    chatSendKeys: [...PHONE_CHAT_SEND_KEYS],
    chatModes: [...PHONE_CHAT_MODES],
    yoloMode: PHONE_YOLO_MODE,
  };
}
