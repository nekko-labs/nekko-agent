/**
 * @nekko-agent/host, the transport-agnostic host. Bundles every service (settings,
 * sessions, chat orchestration, sandboxed tools, workspace index, memory, usage,
 * connectors) behind `createHost()`. Electron, the web server, and Nekko Agent Cloud
 * all wrap the same Host so they run identical behavior.
 */
export { createHost, type Host } from './host.js';
export { createDispatcher } from './dispatch.js';
export { connectRelayAgent, type RelayAgentHandle, type RelayAgentOptions } from './relay.js';
export { createRemoteService, type RemoteService } from './remote.js';
export { dataDir, setDataDir, withDataDir } from './paths.js';
export { defaultUserDataDir, legacyUserDataDirs, migrateUserData, prepareUserDataRoot } from './user-data.js';
export { cleanup as cleanupLegacy, consolidate as consolidateLegacy, describeItem as describeLegacyItem, detectLegacy, summarize as summarizeLegacy, legacyEnv, type CleanupReport, type ConsolidateReport, type LegacyEnv, type LegacyItem } from './legacy-profiles.js';
export { findRunningApp, listProcesses, startApp, stopApp, type ProcInfo, type RunningApp } from './app-control.js';
export { listAgentTerminals, useTerminalDaemon } from './terminal.js';
export { useEngineDaemon } from './engine/daemon.js';
export { reviewRepository, parseRepositoryVerdict, type RepositoryReviewer, type RepositoryReviewInput, type RepositoryReviewVerdict } from './repository-review.js';
export { flushAgentLogs } from './agent-log.js';
