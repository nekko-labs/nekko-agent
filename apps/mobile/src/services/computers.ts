/**
 * Computers this phone is paired with, and the live connection to the active
 * one. Pairing material lives in secure storage only; screens read the
 * non-secret parts (name, relay host, connection state, chat list) from the
 * store. One relay connection at a time: the computer you're looking at.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { deriveKeyBytes, fromHex, toHex } from '@/lib/e2e';
import type { PairingLink } from '@/lib/pairing';
import {
  Channels,
  Events,
  pickDefaults,
  publicProviders,
  visibleSummaries,
  type AgentEvent,
  type ModelInfo,
  type PendingInput,
  type PublicProvider,
  type RemoteDefaults,
  type SessionSummary,
  type WorkspaceFolder,
} from '@/lib/protocol';
import { RelayClient, type DenyReason, type RelayState } from '@/lib/relayClient';
import { nextActivity, type Activity } from '@/lib/transcript';
import { createStore } from '@/lib/store';
import { currentPushToken } from './push';
import { getSecret, setSecret } from './storage';
import { createSummaryScheduler } from './summaryScheduler';

export interface Computer {
  id: string;
  name: string;
  relayUrl: string;
  pairedAt: number;
  /** OS of the computer, learned from app:info once connected. */
  platform?: string;
}

/** Secret half of a pairing, kept in the Keychain/Keystore. */
interface ComputerSecret {
  room: string;
  key: string;
  /** PBKDF2 output, cached so reconnecting doesn't cost a second of CPU. */
  keyHex: string;
  /** Present until the computer welcomes us once. */
  pair?: string;
}

export interface ComputersState {
  ready: boolean;
  computers: Computer[];
  activeId?: string;
  conn: RelayState;
  connDetail?: string;
  denied?: DenyReason;
  summaries: SessionSummary[];
  summariesLoading: boolean;
  providers: PublicProvider[];
  defaults: RemoteDefaults;
  models: Record<string, ModelInfo[]>;
  workspaces: WorkspaceFolder[];
  /** Chats mid-run or waiting on an approval/answer, by session id. */
  activity: Record<string, Activity>;
  lastError?: string;
}

export const computers = createStore<ComputersState>({
  ready: false,
  computers: [],
  conn: 'idle',
  summaries: [],
  summariesLoading: false,
  providers: [],
  defaults: {},
  models: {},
  workspaces: [],
  activity: {},
});

const INDEX_KEY = 'nekko.computers';
const ACTIVE_KEY = 'nekko.activeComputer';
const DEVICE_KEY = 'nekko.deviceId';
const secretKey = (id: string) => `nekko.computer.${id}`;

let client: RelayClient | null = null;
let connectionGeneration = 0;
const summaryScheduler = createSummaryScheduler(
  () => remote().call<SessionSummary[]>(Channels.sessionsSummaries),
  (summaries) => computers.set({ summaries: visibleSummaries(summaries) }),
);

function invalidateSummaries(): void {
  connectionGeneration++;
  summaryScheduler.reset();
}
const eventListeners = new Set<(e: AgentEvent) => void>();

/** Chat screens follow their session's events through this. */
export function onAgentEvent(fn: (e: AgentEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

export function remote(): RelayClient {
  if (!client) throw new Error('Not connected to a computer.');
  return client;
}

export async function loadComputers(): Promise<void> {
  const list = parse<Computer[]>(await getSecret(INDEX_KEY), []);
  const activeId = (await getSecret(ACTIVE_KEY)) ?? list[0]?.id;
  computers.set({ ready: true, computers: list, activeId: list.some((c) => c.id === activeId) ? activeId : list[0]?.id });
  if (computers.get().activeId) void connect(computers.get().activeId!);
}

/** Save a scanned/pasted pairing and connect. Returns the new computer's id. */
export async function pairComputer(link: PairingLink): Promise<string> {
  // Re-scanning a computer we already know keeps its id and name.
  const list = computers.get().computers;
  let existing: Computer | undefined;
  for (const c of list) {
    const s = parse<ComputerSecret | null>(await getSecret(secretKey(c.id)), null);
    if (s?.room === link.room && c.relayUrl === link.relayUrl) existing = c;
  }
  const keyHex = toHex(await deriveKeyBytes(link.key, link.room));
  const id = existing?.id ?? Crypto.randomUUID();
  const secret: ComputerSecret = { room: link.room, key: link.key, keyHex, pair: link.pair };
  await setSecret(secretKey(id), JSON.stringify(secret));
  const computer: Computer = existing ?? { id, name: 'My computer', relayUrl: link.relayUrl, pairedAt: Date.now() };
  const next = existing ? list : [...list, computer];
  await saveIndex(next);
  computers.set({ computers: next });
  await connect(id);
  return id;
}

export async function renameComputer(id: string, name: string): Promise<void> {
  const next = computers.get().computers.map((c) => (c.id === id ? { ...c, name: name.trim().slice(0, 40) || c.name } : c));
  await saveIndex(next);
  computers.set({ computers: next });
}

export async function forgetComputer(id: string): Promise<void> {
  if (computers.get().activeId === id) disconnect();
  await setSecret(secretKey(id), null);
  const next = computers.get().computers.filter((c) => c.id !== id);
  await saveIndex(next);
  const activeId = computers.get().activeId === id ? next[0]?.id : computers.get().activeId;
  await setSecret(ACTIVE_KEY, activeId ?? null);
  computers.set({ computers: next, activeId, summaries: [], providers: [], models: {}, workspaces: [] });
  if (activeId && activeId !== id) void connect(activeId);
}

export async function connect(id: string): Promise<void> {
  disconnect();
  const computer = computers.get().computers.find((c) => c.id === id);
  const secret = parse<ComputerSecret | null>(await getSecret(secretKey(id)), null);
  if (!computer || !secret) return;
  await setSecret(ACTIVE_KEY, id);
  computers.set({ activeId: id, conn: 'connecting', denied: undefined, connDetail: undefined, summaries: [], providers: [], models: {}, activity: {} });

  const c = new RelayClient({
    relayUrl: computer.relayUrl,
    room: secret.room,
    key: secret.key,
    keyBytes: fromHex(secret.keyHex),
    deviceId: await deviceId(),
    deviceName: deviceName(),
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    pairCode: secret.pair,
    onState: (state, detail) => {
      if (client !== c) return;
      if (state !== 'online') invalidateSummaries();
      computers.set({ conn: state, connDetail: detail, ...(state !== 'online' ? { summariesLoading: false } : {}) });
      if (state === 'online') {
        void refresh();
        void currentPushToken().then((t) => {
          if (t && client === c) c.registerPush(t.token, t.platform).catch(() => {});
        });
      }
    },
    onWelcome: () => {
      // Enrollment done: the one-time code must never be sent again.
      if (secret.pair) void setSecret(secretKey(id), JSON.stringify({ ...secret, pair: undefined }));
    },
    onDenied: (reason) => {
      if (client !== c) return;
      computers.set({ denied: reason });
    },
    onEvent: (channel, payload) => {
      if (client !== c || computers.get().conn !== 'online' || channel !== Events.agentEvent) return;
      const e = payload as AgentEvent;
      for (const l of eventListeners) l(e);
      const activity = nextActivity(computers.get().activity, e);
      if (activity !== computers.get().activity) computers.set({ activity });
      // Keep the list fresh when a turn ends anywhere (another device, a task).
      if (e.type === 'done' || e.type === 'session_meta') summaryScheduler.schedule();
    },
  });
  client = c;
  c.connect();
}

export function disconnect(): void {
  invalidateSummaries();
  client?.close();
  client = null;
  computers.set({ conn: 'idle', summariesLoading: false });
}

/** App came to the foreground: reconnect now rather than after the backoff. */
export function nudge(): void {
  client?.nudge();
}

export async function refresh(): Promise<void> {
  if (!client || computers.get().conn !== 'online') return;
  const c = client;
  const generation = connectionGeneration;
  computers.set({ summariesLoading: true, lastError: undefined });
  try {
    const [, providers, settings, workspaces, info, pending] = await Promise.all([
      summaryScheduler.refresh(),
      c.call(Channels.providersList).then(publicProviders),
      c.call(Channels.settingsGet).then(pickDefaults),
      c.call<WorkspaceFolder[]>(Channels.workspaceList).catch(() => []),
      c.call<{ platform?: string }>(Channels.appInfo).catch(() => ({ platform: undefined })),
      c.call<Record<string, PendingInput>>(Channels.chatPending).catch(() => ({})),
    ]);
    if (client !== c || generation !== connectionGeneration) return;
    // Approvals and questions already waiting when we (re)connect.
    const activity = { ...computers.get().activity };
    for (const [sid, p] of Object.entries(pending ?? {})) if (p?.approval || p?.question) activity[sid] = 'needs-you';
    computers.set({ providers, defaults: settings, workspaces, activity, summariesLoading: false });
    learnPlatform(info.platform);
  } catch (e) {
    if (client !== c || generation !== connectionGeneration) return;
    computers.set({ summariesLoading: false, lastError: (e as Error).message });
  }
}

export async function loadModels(providerId: string): Promise<ModelInfo[]> {
  const cached = computers.get().models[providerId];
  if (cached) return cached;
  const list = await remote().call<ModelInfo[]>(Channels.modelsList, providerId);
  // Same rule as providers: keep only what the picker needs.
  const slim = (list ?? []).map((m) => ({ id: m.id, providerId: m.providerId, name: m.name, contextLength: m.contextLength, loaded: m.loaded }));
  computers.set((s) => ({ models: { ...s.models, [providerId]: slim } }));
  return slim;
}

function learnPlatform(platform?: string): void {
  const id = computers.get().activeId;
  if (!id || !platform) return;
  const list = computers.get().computers;
  const c = list.find((x) => x.id === id);
  if (!c || c.platform === platform) return;
  // First connection names the computer after its OS, unless the user renamed it.
  const name = c.name === 'My computer' ? osName(platform) : c.name;
  const next = list.map((x) => (x.id === id ? { ...x, platform, name } : x));
  computers.set({ computers: next });
  void saveIndex(next);
}

export function osName(platform?: string): string {
  if (platform === 'win32') return 'Windows PC';
  if (platform === 'darwin') return 'Mac';
  if (platform === 'linux') return 'Linux PC';
  return 'My computer';
}

async function saveIndex(list: Computer[]): Promise<void> {
  await setSecret(INDEX_KEY, JSON.stringify(list));
}

let cachedDeviceId: string | null = null;
async function deviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id = await getSecret(DEVICE_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await setSecret(DEVICE_KEY, id);
  }
  cachedDeviceId = id;
  return id;
}

function deviceName(): string {
  const n = Device.deviceName || Device.modelName;
  if (n) return n.slice(0, 60);
  return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Browser';
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
