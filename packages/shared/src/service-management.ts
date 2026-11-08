import type { UpdateInfo } from './update.js';

/** Narrow remote APIs. Raw update:* and shell controls remain unavailable to phones. */
export const SERVICE_READ_CHANNELS = ['service:status', 'service:updateState'] as const;
export const SERVICE_CHANGE_CHANNELS = ['service:restart', 'service:updateCheck', 'service:updateDownload', 'service:updateInstall'] as const;
export const SERVICE_CHANNELS = [...SERVICE_READ_CHANNELS, ...SERVICE_CHANGE_CHANNELS] as const;
export const SERVICE_STEP_UP_CHANNELS = ['service:restart', 'service:updateInstall'] as const;

export interface ServiceCapability {
  /** Host support, not permission. Also check manageServiceFromPhone and device access. */
  supported: boolean;
  /** Stable reason code when unsupported. */
  reason?: string;
}

export interface ServiceStatus {
  protocolVersion: 1;
  agentRunning: true;
  /** Absent settings are false. Independent of quitFromPhone. */
  manageServiceFromPhone: boolean;
  capabilities: Record<'restart' | 'updateState' | 'updateCheck' | 'updateDownload' | 'updateInstall', ServiceCapability>;
}

/** Every service call takes an empty positional argument array. Confirm restart/install in the client. */
export interface ServiceReplies {
  'service:status': ServiceStatus;
  'service:updateState': UpdateInfo;
  'service:updateCheck': UpdateInfo;
  'service:updateDownload': UpdateInfo;
  /** Accepted by Electron, not proof of completion. Reconnect and rediscover after restarting. */
  'service:restart': { restarting: true };
  'service:updateInstall': { installing: true };
}
