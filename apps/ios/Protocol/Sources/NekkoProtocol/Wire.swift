import Foundation

/// The slice of the host's IPC surface the phone uses. Names mirror
/// `packages/shared/src/ipc.ts` and the computer's `PHONE_CHANNELS`
/// (`packages/shared/src/phone-access.ts`); pinned by `WireTests`.
public enum Channels {
    public static let settingsGet = "settings:get"
    /// Only the phone-settable keys (`PHONE_SETTINGS_KEYS`); anything else is refused.
    public static let settingsUpdate = "settings:update"
    public static let providersList = "providers:list"
    /// Provider setup from a phone (decision 0016): the computer's sealing key, a sealed save, one provider's switch.
    public static let providersSealKey = "providers:sealKey"
    public static let providersSaveSealed = "providers:saveSealed"
    public static let providersSetEnabled = "providers:setEnabled"
    public static let modelsList = "models:list"
    public static let sessionsSummaries = "sessions:summaries"
    public static let sessionCreate = "session:create"
    public static let sessionGet = "session:get"
    /// A chat's durable watches: what each watches, when it wakes and how that went (never the continuation prompt).
    public static let sessionWatches = "session:watches"
    /// A computer's page in one read: version, hardware, live stats, the model server (`PHONE_MACHINE_VIEW`).
    public static let machineSummary = "machine:summary"
    /// The Monitors pane's one read (`PHONE_MONITOR_VIEW`), added on the computer in #989.
    public static let monitorSummary = "monitor:summary"
    public static let sessionSetOptions = "session:setOptions"
    public static let sessionDelete = "session:delete"
    public static let voiceStatus = "voice:status"
    /// A mono 16 kHz 16-bit PCM WAV as a JSON array of byte values → the text.
    public static let voiceTranscribe = "voice:transcribe"
    public static let chatSend = "chat:send"
    public static let chatAbort = "chat:abort"
    public static let chatQueue = "chat:queue"
    public static let chatPending = "chat:pending"
    public static let chatAnswer = "chat:answer"
    public static let toolApprove = "tool:approve"
    public static let workspaceList = "workspace:list"
    public static let workspaceAddByPath = "workspace:addByPath"
    public static let workspaceRemove = "workspace:remove"
    public static let appInfo = "app:info"
    /// SK-2: a single-use step-up challenge (read class).
    public static let securityChallenge = "security:challenge"
    /// SK-3 safety exits (agent class, never refused for Change off).
    public static let appQuit = "app:quit"
    public static let deviceSignOut = "device:signOut"
    public static let remoteStop = "remote:stop"
    /// Names and descriptions only, never templates.
    public static let skillsRunnable = "skills:runnable"
    /// What the agent changed in a chat, as a capped read-only diff (`PhoneChanges`);
    /// refused unless the computer allows it (`phoneChanges`).
    public static let changesList = "changes:list"
    /// Change or remove a queued prompt, checked against the text the phone showed.
    public static let chatEditQueued = "chat:editQueued"
    /// A new chat with this one's conversation before a message.
    public static let sessionFork = "session:fork"
    /// The computer's automations (read only) and Run now on one the owner set up.
    public static let tasksList = "tasks:list"
    public static let taskRunNow = "task:runNow"
    public static let workflowsList = "workflows:list"
    public static let workflowRun = "workflow:run"
    /// A chat's pull requests: state and checks, read only.
    public static let prSessionList = "pr:sessionList"
    /// Provider usage, and one provider's limits by its id, read only.
    public static let usageSummary = "usage:summary"
    public static let limitsGet = "limits:get"
    /// *Send a test notification*: answered by the computer's relay agent itself,
    /// so it is not on the phone allowlist (`PUSH_TEST_CHANNEL`) and not in `all`.
    public static let pushTest = "push:test"

    /// Git on a chat's folder (IO-33 FA-2, `Git.swift`). Reads: status, diffs,
    /// history, a commit, branches, compare, a PR's checks and diff.
    public static let workspaceGitStatus = "workspace:gitStatus"
    public static let gitDiff = "git:diff"
    public static let gitLog = "git:log"
    public static let gitShow = "git:show"
    public static let gitBranches = "git:branches"
    public static let gitCompare = "git:compare"
    public static let prChecks = "pr:checks"
    public static let prDiff = "pr:diff"
    /// Change actions: signed, so Face ID or the passcode is asked (`ComputersStore.call(change:)`).
    public static let gitStage = "git:stage"
    public static let gitUnstage = "git:unstage"
    public static let gitCommit = "git:commit"
    /// Spends the computer's model tokens, so it is a Change too.
    public static let gitCommitMessage = "git:commitMessage"
    public static let gitPush = "git:push"
    public static let gitSwitch = "git:switch"
    public static let gitMergeAbort = "git:mergeAbort"
    public static let prCreate = "pr:create"
    public static let prAction = "pr:action"

    /// The change-class channels among these (`PHONE_CHANGE_CHANNELS`).
    public static let gitChange: Set<String> = [
        gitStage, gitUnstage, gitCommit, gitCommitMessage, gitPush, gitSwitch, gitMergeAbort, prCreate, prAction,
    ]

    /// Files in a chat's or saved folder's tree (IO-33 FA-1, `Files.swift`): list,
    /// search and read; saving is a Change, checked against the hash read.
    public static let filesList = "files:list"
    public static let filesSearch = "files:search"
    public static let filesRead = "files:read"
    public static let filesWrite = "files:write"
    /// The computer's app, engine and agent logs, read only and redacted there (FA-5).
    public static let logsList = "logs:list"
    public static let logsRead = "logs:read"
    /// The change-class channels among these.
    public static let filesChange: Set<String> = [filesWrite]
    /// What the agent linked in a chat (#1095), read only: a linked file, or a file a
    /// linked page loads from its folder, and a GET/HEAD to a linked local preview server.
    public static let artifactRead = "artifact:read"
    public static let previewFetch = "preview:fetch"
    /// A provider added or switched from the phone (`PHONE_PROVIDER_CHANGE_CHANNELS`): change class, with a proof.
    public static let providersChange: Set<String> = [providersSaveSealed, providersSetEnabled]
    /// Every change-class channel the phone calls (`PHONE_CHANGE_CHANNELS`): signed, so Face ID or the passcode is asked.
    public static let change: Set<String> = gitChange.union(filesChange).union(terminalChange).union(providersChange).union([workspaceAddByPath, workspaceRemove])

    public static let all = [
        settingsGet, settingsUpdate, providersList, modelsList, sessionsSummaries, sessionCreate, sessionGet,
        sessionSetOptions, sessionDelete, voiceStatus, voiceTranscribe, chatSend, chatAbort, chatQueue,
        chatPending, chatAnswer, toolApprove, workspaceList, workspaceAddByPath, workspaceRemove, appInfo, skillsRunnable, changesList,
        chatEditQueued, sessionFork, tasksList, taskRunNow, workflowsList, workflowRun, prSessionList,
        usageSummary, limitsGet, sessionWatches, machineSummary, monitorSummary, securityChallenge, appQuit, deviceSignOut, remoteStop,
        providersSealKey, providersSaveSealed, providersSetEnabled,
        workspaceGitStatus, gitDiff, gitLog, gitShow, gitBranches, gitCompare, prChecks, prDiff,
        gitStage, gitUnstage, gitCommit, gitCommitMessage, gitPush, gitSwitch, gitMergeAbort, prCreate, prAction,
        filesList, filesSearch, filesRead, filesWrite, logsList, logsRead,
        // The Expert monitor and a chat's context gauge (Monitor.swift).
        MonitorChannels.systemStats, MonitorChannels.gpuStats, MonitorChannels.engineStatus, MonitorChannels.contextPreview,
        MonitorChannels.modelUnload,
        artifactRead, previewFetch,
        // IO-33 FA-3, FA-6 (Terminal.swift).
        TerminalChannels.list, TerminalChannels.tail, TerminalChannels.sshHosts, TerminalChannels.create, TerminalChannels.sshOpen,
        TerminalChannels.write, TerminalChannels.resize, TerminalChannels.signal, TerminalChannels.close,
    ]
}

public enum Events {
    public static let agentEvent = "agent:event"
    /// The desktop's theme changed; payload is an `Appearance`.
    public static let appearanceUpdated = "appearance:updated"
}

/// `chat:send` errors unless the session names a concrete, enabled model.
public let autoModelId = "__auto__"

// MARK: - Models

/// One durable `agent_watch` of a chat as the computer reports it
/// (`PHONE_WATCH_VIEW`): joined to the arming call by `id`.
public struct AgentWatch: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case timer, pr }
    public enum Status: String, Sendable { case active, done, cancelled, error }
    public let id: String
    public let kind: Kind
    public let url: String?
    public let status: Status
    /// Timer: when it wakes. PR: the latest it waits before waking anyway. Milliseconds since the epoch.
    public let deadlineAt: Int64
    /// A wake-up is due but the chat has not been continued yet (busy or failing).
    public let pending: Bool
    public let failures: Int
    public let lastError: String?

    public init(id: String, kind: Kind, url: String? = nil, status: Status, deadlineAt: Int64, pending: Bool = false, failures: Int = 0, lastError: String? = nil) {
        self.id = id
        self.kind = kind
        self.url = url
        self.status = status
        self.deadlineAt = deadlineAt
        self.pending = pending
        self.failures = failures
        self.lastError = lastError
    }

    public static func list(_ v: JSONValue?) -> [AgentWatch] {
        (v?.array ?? []).compactMap { w in
            guard let id = w.str("id"), let kind = w.str("kind").flatMap(Kind.init(rawValue:)),
                  let status = w.str("status").flatMap(Status.init(rawValue:)), let deadline = w.long("deadlineAt") else { return nil }
            return AgentWatch(id: id, kind: kind, url: w.str("url"), status: status, deadlineAt: deadline, pending: w.flag("pending"),
                              failures: Int(w.long("failures") ?? 0), lastError: w.str("lastError"))
        }
    }
}

/// What a computer says about itself for its page (`machine:summary`): the
/// daemon builds it without paths or addresses, and the phone shows it as is.
public struct MachineSummary: Equatable, Sendable {
    public struct Gpu: Equatable, Sendable, Identifiable {
        public let name: String
        public let vramBytes: Double?
        public let cores: Int?
        public var id: String { name }
    }
    public struct ResidentModel: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let contextTokens: Int?
    }

    public let version: String?
    public let platform: String?
    public let edition: String?
    public let uptimeMs: Int64
    public let arch: String?
    public let release: String?
    public let cpuModel: String?
    public let cpuCores: Int?
    public let ramBytes: Double?
    public let unified: Bool
    public let gpus: [Gpu]
    public let backends: [String]
    public let engineBackend: String?
    public let engineVersion: String?
    public let diskFreeBytes: Double?
    public let cpuPct: Double?
    public let memUsedMB: Double?
    public let memTotalMB: Double?
    public let cpuC: Double?
    public let gpuC: Double?
    public let gpuUsedMB: Double?
    public let gpuTotalMB: Double?
    public let serverRunning: Bool
    public let serverStartedAt: Int64?
    public let resident: [ResidentModel]
    public let loading: Int

    public static func from(_ v: JSONValue?) -> MachineSummary? {
        guard let v, v.object != nil else { return nil }
        let hw = v["hardware"], live = v["live"], gpu = v["gpu"], engine = v["engine"]
        let gpus: [Gpu] = (hw?["gpus"]?.array ?? []).compactMap { g in
            g.str("name").map { Gpu(name: $0, vramBytes: g.dbl("vramBytes"), cores: g.long("cores").map(Int.init)) }
        }
        let resident: [ResidentModel] = (engine?["resident"]?.array ?? []).compactMap { m in
            m.str("id").map { ResidentModel(id: $0, name: m.str("name") ?? $0, contextTokens: m.long("contextTokens").map(Int.init)) }
        }
        // The hottest GPU the profile reports, else the system sensor.
        let gpuC = (gpu?["devices"]?.array ?? []).compactMap { $0.dbl("temperatureC") }.max() ?? live?["temps"]?.dbl("gpuC")
        return MachineSummary(
            version: v.str("version"), platform: v.str("platform"), edition: v.str("edition"), uptimeMs: v.long("uptimeMs") ?? 0,
            arch: hw?.str("arch"), release: hw?.str("release"), cpuModel: hw?["cpu"]?.str("model") ?? live?.str("cpuModel"),
            cpuCores: (hw?["cpu"]?.long("cores") ?? live?.long("cpuCores")).map(Int.init), ramBytes: hw?.dbl("ramBytes"),
            unified: (hw?.flag("unified") ?? false) || (gpu?.flag("unified") ?? false), gpus: gpus,
            backends: (hw?["backends"]?.array ?? []).compactMap(\.string),
            engineBackend: hw?["engine"]?.str("backend"), engineVersion: hw?["engine"]?.str("version"), diskFreeBytes: hw?.dbl("diskFreeBytes"),
            cpuPct: live?.dbl("cpuPct"), memUsedMB: live?.dbl("memUsedMB"), memTotalMB: live?.dbl("memTotalMB"),
            cpuC: live?["temps"]?.dbl("cpuC"), gpuC: gpuC, gpuUsedMB: gpu?.dbl("usedMB"), gpuTotalMB: gpu?.dbl("totalMB"),
            serverRunning: engine?.flag("running") ?? false, serverStartedAt: engine?.long("startedAt"), resident: resident,
            loading: Int(engine?.long("loading") ?? 0))
    }
}

/// `providers:saveSealed` and `providers:setEnabled` as the computer answers
/// them: whether it worked, why not, and the models a saved provider offers.
public struct ProviderSaveResult: Equatable, Sendable {
    public struct Model: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
    }
    public let ok: Bool
    public let message: String?
    public let models: [Model]

    public static func from(_ v: JSONValue?) -> ProviderSaveResult {
        let models: [Model] = (v?["models"]?.array ?? []).compactMap { m in m.str("id").map { Model(id: $0, name: m.str("name") ?? $0) } }
        return ProviderSaveResult(ok: v?.flag("ok") ?? false, message: v?.str("message"), models: models)
    }
}

public struct ToolCall: Equatable, Sendable {
    public let id: String
    public let name: String
    public let input: [String: JSONValue]

    public init(id: String, name: String, input: [String: JSONValue] = [:]) {
        self.id = id
        self.name = name
        self.input = input
    }

    public static func from(_ v: JSONValue?) -> ToolCall? {
        guard let v, let id = v.str("id"), let name = v.str("name") else { return nil }
        return ToolCall(id: id, name: name, input: v["input"]?.object ?? [:])
    }
}

/// A tool's result. `outputChars` is the original length when the computer cut
/// the output for the phone, `omittedImages` the screenshots it left out
/// (`PHONE_SESSION_VIEW`).
public struct ToolResult: Equatable, Sendable {
    public let toolCallId: String
    public let output: String
    public let isError: Bool
    public let outputChars: Int?
    public let omittedImages: Int

    public static func from(_ v: JSONValue?) -> ToolResult? {
        guard let v, let id = v.str("toolCallId") else { return nil }
        let output: String
        switch v["output"] {
        case .string(let s): output = s
        case .none, .null: output = ""
        case .some(let other): output = other.serialized()
        }
        var chars: Int?
        if v.flag("truncated"), let n = v.long("outputChars"), Int(n) > output.count { chars = Int(n) }
        return ToolResult(toolCallId: id, output: output, isError: v.flag("isError"), outputChars: chars,
                          omittedImages: max(0, Int(v.long("omittedImages") ?? 0)))
    }
}

public struct ChatMessage: Equatable, Sendable {
    public let id: String
    public let role: String
    public let content: String
    public let reasoning: String?
    public let createdAt: Int64?
    public let imageCount: Int
    /// The user's photos as the computer sent them: small JPEG data URLs, `""` for one it kept back.
    public var images: [String] = []
    public let skill: (name: String, input: String)?
    public let toolCalls: [ToolCall]
    public let toolResult: ToolResult?
    public let interrupted: Bool

    public static func == (a: ChatMessage, b: ChatMessage) -> Bool {
        a.id == b.id && a.role == b.role && a.content == b.content && a.reasoning == b.reasoning
            && a.createdAt == b.createdAt && a.imageCount == b.imageCount && a.skill?.name == b.skill?.name
            && a.skill?.input == b.skill?.input && a.toolCalls == b.toolCalls && a.toolResult == b.toolResult
            && a.interrupted == b.interrupted && a.images == b.images
    }

    public static func from(_ v: JSONValue?) -> ChatMessage? {
        guard let v, let id = v.str("id"), let role = v.str("role") else { return nil }
        var skill: (String, String)?
        if let s = v["skill"], let name = s.str("name") { skill = (name, s.str("input") ?? "") }
        return ChatMessage(
            id: id, role: role, content: v.str("content") ?? "", reasoning: v.str("reasoning"),
            // The phone's saved copy (`SavedTranscripts`) keeps only how many photos there were.
            createdAt: v.long("createdAt"), imageCount: v["images"]?.array?.count ?? max(0, Int(v.long("imageCount") ?? 0)),
            images: v["images"]?.array?.map { $0.string ?? "" } ?? [], skill: skill,
            toolCalls: v["toolCalls"]?.array?.compactMap(ToolCall.from) ?? [],
            toolResult: ToolResult.from(v["toolResult"]), interrupted: v.flag("interrupted"))
    }
}

public struct Session: Equatable, Sendable {
    public let id: String
    public let title: String
    public let providerId: String?
    public let modelId: String?
    public let workspaceId: String?
    public let mode: String?
    public let messages: [ChatMessage]
    /// Older messages the computer kept back from the phone (only the newest are sent).
    public let omittedMessages: Int
    /// Queued prompts as the composer shows them (a skill's as `/name input`).
    public let queue: [String]
    public let updatedAt: Int64
    /// The queue as the computer holds it: what `chat:editQueued` checks against.
    public var queued: [QueuedPrompt] = []
    /// The outbox ids this chat has taken (`chat:send` / `chat:queue` with a
    /// `clientMessageId`): a prompt whose id is here was delivered.
    public var clientMessageIds: [String] = []
    /// A turn is running on the computer (`activeRun`): a prompt waits in its queue.
    public var running = false
    /// The chat's effort (`EffortLevel`); nil follows the computer's setting.
    public var effort: String?

    public static func from(_ v: JSONValue?) -> Session? {
        guard let v, let id = v.str("id") else { return nil }
        return Session(
            id: id, title: v.str("title") ?? "", providerId: v.str("providerId"), modelId: v.str("modelId"),
            workspaceId: v.str("workspaceId"), mode: v.str("mode"),
            messages: v["messages"]?.array?.compactMap(ChatMessage.from) ?? [],
            omittedMessages: max(0, Int(v.long("omittedMessages") ?? 0)),
            // Queue entries may be plain strings or {text, images, skill}.
            queue: QueuedPrompt.list(v["queue"]).map(\.shown),
            updatedAt: v.long("updatedAt") ?? 0,
            queued: QueuedPrompt.list(v["queue"]),
            clientMessageIds: v["clientMessageIds"]?.array?.compactMap(\.string) ?? [],
            running: v["activeRun"].map { !$0.isNull } ?? false,
            effort: v.str("effort"))
    }
}

public struct SessionSummary: Equatable, Sendable, Identifiable {
    public let id: String
    public var title: String
    public let updatedAt: Int64
    public let modelId: String?
    public let lastReplyText: String?
    public let firstUserText: String?
    public var archived: Bool
    public let parentSessionId: String?
    public let taskId: String?
    public let trainingRunId: String?
    public let providerId: String?
    /// The project folder (`workspace:list` id); nil for General.
    public let workspaceId: String?
    /// When the chat was completed (the desktop's archive); nil while active.
    public var archivedAt: Int64?
    /// Manual position from the desktop sidebar's drag order.
    public let order: Double?
    public var pinned: Bool
    public let activeWatchCount: Int64

    /// Real, top-level chats, active or completed: what the phone lists.
    public var isVisible: Bool { parentSessionId == nil && taskId == nil && trainingRunId == nil }

    public static func from(_ v: JSONValue?) -> SessionSummary? {
        guard let v, let id = v.str("id") else { return nil }
        let archivedAt = v.long("archivedAt").flatMap { $0 == 0 ? nil : $0 }
        return SessionSummary(
            id: id, title: v.str("title") ?? "", updatedAt: v.long("updatedAt") ?? 0, modelId: v.str("modelId"),
            lastReplyText: v.str("lastReplyText"), firstUserText: v.str("firstUserText"), archived: archivedAt != nil,
            parentSessionId: v.str("parentSessionId"), taskId: v.str("taskId"), trainingRunId: v.str("trainingRunId"),
            providerId: v.str("providerId"), workspaceId: v.str("workspaceId"), archivedAt: archivedAt,
            order: v.dbl("order"), pinned: v.flag("pinned"), activeWatchCount: v.long("activeWatchCount") ?? 0)
    }

    /// Every chat the computer listed, children and task chats included, as sent.
    public static func list(_ list: JSONValue?) -> [SessionSummary] {
        (list?.array ?? []).compactMap(from)
    }

    /// Every top-level chat, completed ones included, newest first.
    public static func visible(_ list: JSONValue?) -> [SessionSummary] {
        (list?.array ?? []).compactMap(from).filter(\.isVisible).sorted { $0.updatedAt > $1.updatedAt }
    }
}

/// One group of the chat list as the desktop's agent sidebar draws it:
/// General for chats in no known folder, then one per project folder.
public struct ChatGroup: Equatable, Sendable, Identifiable {
    public static let general = "__none"
    public let key: String
    public let name: String
    /// Active chats: dragged ones in manual order first, then most recent.
    public let active: [SessionSummary]
    /// Completed chats, most recently completed first.
    public let completed: [SessionSummary]
    public var id: String { key }

    public static func of(_ chats: [SessionSummary], folders: [WorkspaceFolder]) -> [ChatGroup] {
        let known = Set(folders.map(\.id))
        let byGroup = Dictionary(grouping: chats) { s in s.workspaceId.flatMap { known.contains($0) ? $0 : nil } ?? general }
        func group(_ key: String, _ name: String) -> ChatGroup {
            let all = byGroup[key] ?? []
            let active = all.filter { !$0.archived }.sorted { a, b in
                switch (a.order, b.order) {
                case let (x?, y?) where x != y: return x < y
                case (.some, .none): return true
                case (.none, .some): return false
                default: return a.updatedAt > b.updatedAt
                }
            }
            let completed = all.filter(\.archived).sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
            return ChatGroup(key: key, name: name, active: active, completed: completed)
        }
        var out: [ChatGroup] = []
        let g = group(general, "General")
        if !g.active.isEmpty || !g.completed.isEmpty { out.append(g) }
        out += folders.map { group($0.id, $0.name) }
        return out
    }
}

/// A provider as the phone keeps it: never the API key, base URL or token reference.
public struct PublicProvider: Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let enabled: Bool

    public static func list(_ v: JSONValue?) -> [PublicProvider] {
        (v?.array ?? []).compactMap { p in
            guard let id = p.str("id") else { return nil }
            return PublicProvider(id: id, kind: p.str("kind") ?? "", label: p.str("label") ?? id, enabled: p.flag("enabled"))
        }
    }

    /// A model server on a computer (`LOCAL_PROVIDER_KINDS`, packages/shared/src/models.ts), not a cloud API.
    public var isLocal: Bool { ["llamacpp", "ollama", "lmstudio", "vllm"].contains(kind) }
}

/// The settings fields the phone reads (`settings:get` returns the phone view only).
public struct RemoteDefaults: Equatable, Sendable {
    public var defaultProviderId: String?
    public var defaultModelId: String?
    /// The computer's starred models, as `providerId::modelId`.
    public var favoriteModels: [String]

    public init(defaultProviderId: String? = nil, defaultModelId: String? = nil, favoriteModels: [String] = []) {
        self.defaultProviderId = defaultProviderId
        self.defaultModelId = defaultModelId
        self.favoriteModels = favoriteModels
    }

    public static func from(_ v: JSONValue?) -> RemoteDefaults {
        guard let v else { return RemoteDefaults() }
        return RemoteDefaults(defaultProviderId: v.str("defaultProviderId"), defaultModelId: v.str("defaultModelId"),
                              favoriteModels: v["favoriteModels"]?.array?.compactMap(\.string) ?? [])
    }
}

/// The computer's settings a phone may see and change (`PHONE_SETTINGS_KEYS`).
public struct PcSettings: Equatable, Sendable {
    public enum ChatMode: String, CaseIterable, Sendable { case ask, guardrails, yolo }
    public enum ChatAction: String, CaseIterable, Sendable { case complete, delete }

    public var defaultChatMode: ChatMode?
    public var chatPaneAction: ChatAction?
    public var skipDeleteConfirmation: Bool?
    /// False until the computer has answered on this connection.
    public var known: Bool
    public var voiceEnabled: Bool
    /// Whether the computer lets phones read a chat's changes (set on the computer only).
    public var phoneChanges: Bool
    /// The computer's saved prompts (names and text only), for the composer's `/` menu.
    public var prompts: [SavedPrompt]
    /// The computer's automations are paused (set on the computer only).
    public var automationsPaused: Bool

    public init(defaultChatMode: ChatMode? = nil, chatPaneAction: ChatAction? = nil, skipDeleteConfirmation: Bool? = nil,
                known: Bool = false, voiceEnabled: Bool = false, phoneChanges: Bool = false, prompts: [SavedPrompt] = [],
                automationsPaused: Bool = false) {
        self.defaultChatMode = defaultChatMode
        self.chatPaneAction = chatPaneAction
        self.skipDeleteConfirmation = skipDeleteConfirmation
        self.known = known
        self.voiceEnabled = voiceEnabled
        self.phoneChanges = phoneChanges
        self.prompts = prompts
        self.automationsPaused = automationsPaused
    }

    /// What the computer does when a key is unset (shared/settings.ts defaults).
    public var effectiveMode: ChatMode { defaultChatMode ?? .guardrails }
    public var effectiveAction: ChatAction { chatPaneAction ?? .complete }
    public var confirmDelete: Bool { skipDeleteConfirmation != true }

    public static func from(_ v: JSONValue?) -> PcSettings {
        guard let v, v.object != nil else { return PcSettings() }
        return PcSettings(defaultChatMode: v.str("defaultChatMode").flatMap(ChatMode.init(rawValue:)),
                          chatPaneAction: v.str("chatPaneAction").flatMap(ChatAction.init(rawValue:)),
                          skipDeleteConfirmation: v["skipDeleteConfirmation"]?.bool, known: true,
                          voiceEnabled: v["voice"]?.flag("enabled") == true, phoneChanges: v.flag("phoneChanges"),
                          prompts: SavedPrompt.list(v["prompts"]), automationsPaused: v.flag("automationsPaused"))
    }

    /// The `settings:update` patch for one change: never more than the phone-settable keys.
    public static func patch(mode: ChatMode? = nil, action: ChatAction? = nil, skipConfirm: Bool? = nil) -> JSONValue {
        var o: [String: JSONValue] = [:]
        if let mode { o["defaultChatMode"] = .string(mode.rawValue) }
        if let action { o["chatPaneAction"] = .string(action.rawValue) }
        if let skipConfirm { o["skipDeleteConfirmation"] = .bool(skipConfirm) }
        return .object(o)
    }
}

/// One chat's changes as the computer shows them to a phone (`phoneChangesView`,
/// packages/shared/src/phone-changes.ts): paths cut to their last two parts,
/// secret files counted but never shown, big files summarised.
public struct PhoneChanges: Equatable, Sendable {
    public struct Hunk: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case same, removed, added }
        public struct Line: Equatable, Sendable {
            public let kind: Kind
            public let text: String
            /// The line's number in the new file, or the old one for a removed line.
            public let number: Int
        }
        public let oldStart: Int
        public let newStart: Int
        public let lines: [Line]

        /// Lines as the computer sent them (`' '`, `'-'` or `'+'` first), numbered from the starts.
        public init(oldStart: Int, newStart: Int, raw: [String]) {
            self.oldStart = oldStart
            self.newStart = newStart
            var (o, n) = (oldStart, newStart)
            lines = raw.map { r in
                let text = String(r.dropFirst())
                switch r.first {
                case "-": defer { o += 1 }; return Line(kind: .removed, text: text, number: o)
                case "+": defer { n += 1 }; return Line(kind: .added, text: text, number: n)
                default: defer { o += 1; n += 1 }; return Line(kind: .same, text: text, number: n)
                }
            }
        }
    }

    public struct File: Equatable, Sendable, Identifiable {
        public enum Shown: Equatable, Sendable { case diff, hidden, binary, tooLarge(lines: Int) }
        public let path: String
        public let added: Bool
        public let linesAdded: Int
        public let linesRemoved: Int
        public let hunks: [Hunk]
        public let shown: Shown
        public var id: String { path }
    }

    public let files: [File]
    /// Changed files past the computer's limit, not listed.
    public let omittedFiles: Int

    /// Changed lines quoted at most, so a big hunk stays a short message.
    public static let quoteLines = 12

    /// What "Ask about this change" puts in the message box: the file, the line
    /// range, and the hunk's changed lines quoted as a diff. Never sent on its own.
    public static func quote(_ file: File, hunk: Hunk) -> String {
        let changed = hunk.lines.filter { $0.kind != .same }
        let numbers = changed.map(\.number)
        let range = numbers.isEmpty ? "" : numbers.min() == numbers.max() ? " line \(numbers.min()!)" : " lines \(numbers.min()!)–\(numbers.max()!)"
        var body = changed.prefix(quoteLines).map { ($0.kind == .added ? "+" : "-") + $0.text }
        if changed.count > quoteLines { body.append("… \(changed.count - quoteLines) more") }
        return "About `\(file.path)`\(range):\n```diff\n\(body.joined(separator: "\n"))\n```\n\n"
    }

    /// The same for a whole file.
    public static func quote(_ file: File) -> String {
        "About `\(file.path)` (\(file.added ? "new, " : "")+\(file.linesAdded) −\(file.linesRemoved)):\n\n"
    }

    public var linesAdded: Int { files.reduce(0) { $0 + $1.linesAdded } }
    public var linesRemoved: Int { files.reduce(0) { $0 + $1.linesRemoved } }

    public static func from(_ v: JSONValue?) -> PhoneChanges {
        let files: [File] = v?["files"]?.array?.compactMap { f in
            guard let path = f.str("path") else { return nil }
            let shown: File.Shown = f.flag("hidden") ? .hidden : f.flag("binary") ? .binary
                : f.flag("tooLarge") ? .tooLarge(lines: Int(f["lines"]?.int64 ?? 0)) : .diff
            let hunks: [Hunk] = shown == .diff ? (f["hunks"]?.array ?? []).compactMap { h in
                guard let o = h["oldStart"]?.int64, let n = h["newStart"]?.int64 else { return nil }
                return Hunk(oldStart: Int(o), newStart: Int(n), raw: h["lines"]?.array?.compactMap(\.string) ?? [])
            } : []
            return File(path: path, added: f.str("status") == "added", linesAdded: Int(f["added"]?.int64 ?? 0),
                        linesRemoved: Int(f["removed"]?.int64 ?? 0), hunks: hunks, shown: shown)
        } ?? []
        return PhoneChanges(files: files, omittedFiles: Int(v?["omittedFiles"]?.int64 ?? 0))
    }
}

/// The desktop's look (`appearanceOf`, packages/shared/src/themes.ts).
public struct Appearance: Equatable, Sendable {
    public enum Theme: String, Sendable { case system, light, dark }
    public var theme: Theme
    public var preset: String?
    /// `0xRRGGBB`
    public var accent: UInt32?
    public var accent2: UInt32?

    public init(theme: Theme = .system, preset: String? = nil, accent: UInt32? = nil, accent2: UInt32? = nil) {
        self.theme = theme
        self.preset = preset
        self.accent = accent
        self.accent2 = accent2
    }

    public static func from(_ v: JSONValue?) -> Appearance {
        guard let v else { return Appearance() }
        let theme: Theme = v.str("theme") == "light" ? .light : v.str("theme") == "dark" ? .dark : .system
        let preset = v.str("themePreset").flatMap { p in
            (1...32).contains(p.count) && p.allSatisfy { ($0.isLetter && $0.isLowercase && $0.isASCII) || ($0.isNumber && $0.isASCII) || $0 == "-" } ? p : nil
        }
        return Appearance(theme: theme, preset: preset, accent: hex(v.str("accent")), accent2: hex(v.str("accent2")))
    }

    public static func hex(_ s: String?) -> UInt32? {
        guard let s, s.count == 7, s.first == "#" else { return nil }
        return UInt32(s.dropFirst(), radix: 16)
    }
}

public struct ModelInfo: Equatable, Sendable, Identifiable {
    public let id: String
    public let providerId: String
    public let name: String
    public let loaded: Bool

    public static func list(_ v: JSONValue?) -> [ModelInfo] {
        (v?.array ?? []).compactMap { m in
            guard let id = m.str("id") else { return nil }
            let name = m.str("name").flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? id
            return ModelInfo(id: id, providerId: m.str("providerId") ?? "", name: name, loaded: m.flag("loaded"))
        }
    }
}

public struct WorkspaceFolder: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String

    public let path: String?

    public init(id: String, name: String, path: String? = nil) {
        self.id = id
        self.name = name
        self.path = path
    }

    public static func list(_ v: JSONValue?) -> [WorkspaceFolder] {
        (v?.array ?? []).compactMap { w in w.str("id").map { WorkspaceFolder(id: $0, name: w.str("name") ?? "Folder", path: w.str("path")) } }
    }
}

public struct AppInfo: Equatable, Sendable {
    public let version: String?
    public let platform: String?
    /// The owner lets a phone quit Nekko Agent there (SK-3, `app:quit`); false from older computers.
    public var quitFromPhone = false

    public static func from(_ v: JSONValue?) -> AppInfo {
        AppInfo(version: v?.str("version"), platform: v?.str("platform"), quitFromPhone: v?.flag("quitFromPhone") ?? false)
    }
}

public struct VoiceInstall: Equatable, Sendable {
    public let installed: Bool
    public let installing: Bool

    public static func from(_ v: JSONValue?) -> VoiceInstall {
        VoiceInstall(installed: v?.flag("installed") ?? false, installing: v?.flag("installing") ?? false)
    }
}

/// `voice:transcribe`'s argument: the WAV bytes as numbers 0…255, as the desktop sends them.
public func wavArg(_ wav: Data) -> JSONValue { .array(wav.map { .int(Int64($0)) }) }

// MARK: - Ask / approvals

public struct AskOption: Equatable, Sendable, Hashable {
    public let label: String
    public let description: String?
}

public struct AskQuestion: Equatable, Sendable, Identifiable {
    public let id: String
    public let header: String
    public let question: String
    public let options: [AskOption]
    public let multiSelect: Bool
}

public struct AskRequest: Equatable, Sendable {
    public let callId: String
    public let questions: [AskQuestion]
    public let askedAt: Int64

    public static func from(_ v: JSONValue?) -> AskRequest? {
        guard let v, let callId = v.str("callId") else { return nil }
        let qs: [AskQuestion] = (v["questions"]?.array ?? []).compactMap { q in
            guard let id = q.str("id") else { return nil }
            let opts: [AskOption] = (q["options"]?.array ?? []).compactMap { o in
                o.str("label").map { AskOption(label: $0, description: o.str("description")) }
            }
            return AskQuestion(id: id, header: q.str("header") ?? "", question: q.str("question") ?? "", options: opts,
                               multiSelect: q.flag("multiSelect"))
        }
        return AskRequest(callId: callId, questions: qs, askedAt: v.long("askedAt") ?? 0)
    }
}

/// The label every question carries for an answer that isn't on the list (shared/ask.ts).
public let askOtherLabel = "Something else"

public struct AskAnswer: Equatable, Sendable {
    public let questionId: String
    public let labels: [String]
    public let note: String?

    public init(questionId: String, labels: [String], note: String? = nil) {
        self.questionId = questionId
        self.labels = labels
        self.note = note
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["questionId": .string(questionId), "labels": .array(labels.map { .string($0) })]
        if let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { o["note"] = .string(note) }
        return .object(o)
    }
}

public enum Severity: String, Sendable {
    case low, medium, high
    public static func parse(_ s: String?) -> Severity { s == "high" ? .high : s == "medium" ? .medium : .low }
}

public struct Approval: Equatable, Sendable {
    public let call: ToolCall
    public let reason: String
    public let severity: Severity

    public init(call: ToolCall, reason: String, severity: Severity) {
        self.call = call
        self.reason = reason
        self.severity = severity
    }
}

public struct PendingInput: Equatable, Sendable {
    public let sessionId: String
    public let approval: Approval?
    public let question: AskRequest?

    /// `chat:pending` → `Record<sessionId, PendingInput>`.
    public static func map(_ v: JSONValue?) -> [String: PendingInput] {
        var out: [String: PendingInput] = [:]
        for (sid, p) in v?.object ?? [:] {
            guard p.object != nil else { continue }
            var approval: Approval?
            if let a = p["approval"], let call = ToolCall.from(a["call"]) {
                approval = Approval(call: call, reason: a.str("reason") ?? "", severity: .parse(a.str("severity")))
            }
            out[sid] = PendingInput(sessionId: sid, approval: approval, question: AskRequest.from(p["question"]))
        }
        return out
    }
}

// MARK: - Agent events (shared/chat.ts AgentEvent); unknown types decode to .other.

public enum AgentEvent: Equatable, Sendable {
    case text(sessionId: String, delta: String)
    case reasoning(sessionId: String, delta: String)
    case toolCall(sessionId: String, call: ToolCall)
    case approvalRequired(sessionId: String, approval: Approval)
    case toolResult(sessionId: String, result: ToolResult)
    case question(sessionId: String, request: AskRequest)
    case questionResolved(sessionId: String, callId: String)
    case usage(sessionId: String, outputTokens: Int64, outputMs: Int64?)
    case retry(sessionId: String)
    case done(sessionId: String, messageId: String?)
    case error(sessionId: String, message: String)
    case sessionMeta(sessionId: String)
    case other(sessionId: String, type: String)

    public var sessionId: String {
        switch self {
        case .text(let s, _), .reasoning(let s, _), .toolCall(let s, _), .approvalRequired(let s, _), .toolResult(let s, _),
             .question(let s, _), .questionResolved(let s, _), .usage(let s, _, _), .retry(let s), .done(let s, _),
             .error(let s, _), .sessionMeta(let s), .other(let s, _):
            return s
        }
    }

    public var endsTurn: Bool {
        switch self {
        case .done, .error: return true
        default: return false
        }
    }

    public static func from(_ v: JSONValue?) -> AgentEvent? {
        guard let v, let sid = v.str("sessionId"), let type = v.str("type") else { return nil }
        switch type {
        case "text": return .text(sessionId: sid, delta: v.str("delta") ?? "")
        case "reasoning": return .reasoning(sessionId: sid, delta: v.str("delta") ?? "")
        case "tool_call": return ToolCall.from(v["call"]).map { .toolCall(sessionId: sid, call: $0) }
        case "tool_approval_required":
            return ToolCall.from(v["call"]).map {
                .approvalRequired(sessionId: sid, approval: Approval(call: $0, reason: v.str("reason") ?? "", severity: .parse(v.str("severity"))))
            }
        case "tool_result": return ToolResult.from(v["result"]).map { .toolResult(sessionId: sid, result: $0) }
        case "question": return AskRequest.from(v["request"]).map { .question(sessionId: sid, request: $0) }
        case "question_resolved": return v.str("callId").map { .questionResolved(sessionId: sid, callId: $0) }
        case "usage": return .usage(sessionId: sid, outputTokens: v.long("outputTokens") ?? 0, outputMs: v.long("outputMs"))
        case "retry": return .retry(sessionId: sid)
        case "done": return .done(sessionId: sid, messageId: v.str("messageId"))
        case "error": return .error(sessionId: sid, message: v.str("message") ?? "Something went wrong.")
        case "session_meta": return .sessionMeta(sessionId: sid)
        default: return .other(sessionId: sid, type: type)
        }
    }
}

/// A skill the computer can run (`skills:runnable`). The computer keeps the
/// instructions; a skill turn sends just the name and the user's input.
public struct SkillSummary: Equatable, Sendable, Identifiable, Hashable {
    public let name: String
    public let description: String
    public let category: String
    public let source: String
    public var id: String { name }

    public init(name: String, description: String = "", category: String = "", source: String = "") {
        self.name = name
        self.description = description
        self.category = category
        self.source = source
    }

    public static func list(_ v: JSONValue?) -> [SkillSummary] {
        (v?.array ?? []).compactMap { s in
            guard let name = s.str("name"), !name.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return SkillSummary(name: name, description: s.str("description") ?? "", category: s.str("category") ?? "", source: s.str("source") ?? "")
        }
    }
}

public func skillCall(name: String, input: String) -> JSONValue { ["name": .string(name), "input": .string(input)] }

/// `chat:send` argument (SendOptions): only `PHONE_CHAT_SEND_KEYS`.
/// `images` are `data:image/jpeg;base64,…` URLs.
/// `clientMessageId` is the outbox's id for the prompt: the computer answers a
/// repeat of it without a second turn (exactly-once delivery after a reconnect).
public func sendOptions(sessionId: String, providerId: String, modelId: String, text: String,
                        skill: SkillSummary? = nil, images: [String] = [], clientMessageId: String? = nil) -> JSONValue {
    var o: [String: JSONValue] = ["sessionId": .string(sessionId), "providerId": .string(providerId),
                                  "modelId": .string(modelId), "text": .string(text)]
    if let skill { o["skill"] = skillCall(name: skill.name, input: text) }
    if !images.isEmpty { o["images"] = .array(images.map { .string($0) }) }
    if let clientMessageId { o["clientMessageId"] = .string(clientMessageId) }
    return .object(o)
}

/// `chat:queue` prompt: plain text, or `{text, skill, images, clientMessageId}`.
public func queuePrompt(text: String, skill: SkillSummary? = nil, images: [String] = [], clientMessageId: String? = nil) -> JSONValue {
    if skill == nil && images.isEmpty && clientMessageId == nil { return .string(text) }
    var o: [String: JSONValue] = ["text": .string(text)]
    if let skill { o["skill"] = skillCall(name: skill.name, input: text) }
    if !images.isEmpty { o["images"] = .array(images.map { .string($0) }) }
    if let clientMessageId { o["clientMessageId"] = .string(clientMessageId) }
    return .object(o)
}
