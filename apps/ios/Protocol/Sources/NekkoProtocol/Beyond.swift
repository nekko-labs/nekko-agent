import Foundation

// What the phone reads beyond a chat's transcript, as the computer projects it
// for phones (packages/shared/src/phone-views.ts): a chat's queue, the saved
// prompts, the computer's automations, a chat's pull requests, and provider
// usage and limits. All read only, except editing the phone's own queue and
// Run now on an automation the owner already set up.

/// One prompt waiting in a chat's queue on the computer.
/// A run setting a phone shows for a chat, sent to the computer running it. No
/// `values` means on or off. The computer checks every one, and asks for Face ID
/// for those that change what an agent may touch.
public struct RunOption: Sendable, Identifiable, Equatable {
    public let key: String
    public let values: [String]
    public var id: String { key }

    public static let all = [
        RunOption(key: "autoModel", values: []),
        RunOption(key: "offline", values: []),
        RunOption(key: "cloudOnly", values: []),
        RunOption(key: "incognito", values: []),
        RunOption(key: "gitIsolation", values: []),
        RunOption(key: "workMode", values: ["default", "better-review", "design", "best-output"]),
        RunOption(key: "toolApproach", values: ["list", "code"]),
    ]

    /// A chat's run settings, as the computer holds them.
    public static func values(of v: JSONValue?) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for o in all { if let value = v?[o.key], !value.isNull { out[o.key] = value } }
        return out
    }
}

public struct QueuedPrompt: Equatable, Sendable {
    /// The text the computer holds: what an edit is checked against (`expect`).
    public let text: String
    public let skillName: String?
    public let skillInput: String?
    public let images: Int

    public init(text: String, skillName: String? = nil, skillInput: String? = nil, images: Int = 0) {
        self.text = text
        self.skillName = skillName
        self.skillInput = skillInput
        self.images = images
    }

    /// What the composer shows: a skill's prompt as `/name input`, never its instructions.
    public var shown: String {
        guard let skillName else { return text }
        return "/\(skillName) \(skillInput ?? "")".trimmingCharacters(in: .whitespaces)
    }

    /// A skill's text is its instructions: it can be removed, not edited.
    public var editable: Bool { skillName == nil }


    public static func list(_ v: JSONValue?) -> [QueuedPrompt] {
        (v?.array ?? []).compactMap { q in
            if let s = q.string { return QueuedPrompt(text: s) }
            guard q.object != nil else { return nil }
            return QueuedPrompt(text: q.str("text") ?? "", skillName: q["skill"]?.str("name"), skillInput: q["skill"]?.str("input"),
                                images: q["images"]?.array?.count ?? 0)
        }
    }

    /// `chat:editQueued`'s edit: the text the phone showed, and the new text (nil removes it).
    public static func edit(expect: String, text: String?) -> JSONValue {
        var o: [String: JSONValue] = ["expect": .string(expect)]
        if let text { o["text"] = .string(text) }
        return .object(o)
    }
}

/// A prompt the user saved on the computer (`AppSettings.prompts`): its name and text.
public struct SavedPrompt: Equatable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let body: String

    public init(id: String, name: String, body: String) {
        self.id = id
        self.name = name
        self.body = body
    }

    /// What a turn sends for it, the way the desktop's `/name` does: the text, then what was typed.
    public func text(input: String) -> String {
        [body.trimmingCharacters(in: .whitespacesAndNewlines), input.trimmingCharacters(in: .whitespacesAndNewlines)]
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    public static func list(_ v: JSONValue?) -> [SavedPrompt] {
        (v?.array ?? []).compactMap { p in
            guard let name = p.str("name"), let body = p.str("body"), !name.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return SavedPrompt(id: p.str("id") ?? name, name: name, body: body)
        }
    }
}

/// A scheduled, recurring or background task on the computer (`tasks:list`).
public struct AutomationTask: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case scheduled, recurring, background }
    public let id: String
    public let title: String
    public let kind: Kind
    public let status: String
    public let runAt: Int64?
    public let intervalMs: Int64?
    public let untilDone: Bool
    public let lastRunAt: Int64?
    public let nextRunAt: Int64?
    public let runCount: Int
    public let lastSessionId: String?
    public let lastResult: String?

    /// `taskCadence` (packages/shared/src/tasks.ts), in words.
    public var cadence: String {
        switch kind {
        case .scheduled: return runAt.map { "Once, " + AutomationTask.when($0) } ?? "Once"
        case .recurring: return "Every " + AutomationTask.interval(intervalMs ?? 0)
        case .background: return untilDone ? "Until it’s done" : "Runs in the background"
        }
    }

    public var paused: Bool { status == "paused" }
    public var failed: Bool { status == "error" }

    public static func interval(_ ms: Int64) -> String {
        let min = Int((Double(ms) / 60_000).rounded())
        if min < 60 { return min == 1 ? "minute" : "\(max(min, 1)) minutes" }
        let hr = Double(min) / 60
        if hr < 24 { return hr == 1 ? "hour" : "\(formatted(hr)) hours" }
        let d = hr / 24
        return d == 1 ? "day" : "\(formatted(d)) days"
    }

    private static func formatted(_ x: Double) -> String { x == x.rounded() ? String(Int(x)) : String(format: "%.1f", x) }

    static func when(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    public static func list(_ v: JSONValue?) -> [AutomationTask] {
        (v?.array ?? []).compactMap { t in
            guard let id = t.str("id") else { return nil }
            return AutomationTask(id: id, title: t.str("title") ?? "Task", kind: Kind(rawValue: t.str("kind") ?? "") ?? .scheduled,
                                  status: t.str("status") ?? "active", runAt: t.long("runAt"), intervalMs: t.long("intervalMs"),
                                  untilDone: t.str("keepAlive") == "until", lastRunAt: t.long("lastRunAt"), nextRunAt: t.long("nextRunAt"),
                                  runCount: Int(t.long("runCount") ?? 0), lastSessionId: t.str("lastSessionId"),
                                  lastResult: t.str("lastResult").flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 })
        }
    }
}

/// A workflow on the computer (`workflows:list`): name and state, never its steps.
public struct AutomationWorkflow: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let category: String
    public let enabled: Bool
    public let stepCount: Int
    public let lastRunAt: Int64?
    /// `queued`, `running`, `success`, `failure` or `cancelled`.
    public let lastStatus: String?
    public let runCount: Int
    public let nextRunAt: Int64?

    public static func list(_ v: JSONValue?) -> [AutomationWorkflow] {
        (v?.array ?? []).compactMap { w in
            guard let id = w.str("id") else { return nil }
            return AutomationWorkflow(id: id, name: w.str("name") ?? "Workflow", description: w.str("description"),
                                      category: w.str("category") ?? "", enabled: w.flag("enabled"), stepCount: Int(w.long("stepCount") ?? 0),
                                      lastRunAt: w.long("lastRunAt"), lastStatus: w.str("lastStatus"), runCount: Int(w.long("runCount") ?? 0),
                                      nextRunAt: w.long("nextRunAt"))
        }
    }
}

/// A chat's pull request (`pr:sessionList`): its state and checks.
public struct PullRequest: Equatable, Sendable, Identifiable {
    public enum State: String, Sendable { case open, merged, closed }
    public enum Checks: String, Sendable { case passing, failing, pending, none }
    public let url: String
    public let number: Int
    public let title: String
    public let state: State
    public let isDraft: Bool
    public let checks: Checks
    public let reviewDecision: String?
    public let additions: Int
    public let deletions: Int
    public let changedFiles: Int
    public var id: String { url }

    /// The chip's words: `#12 Open · Checks failing`.
    public var summary: String {
        let s: String
        switch state {
        case .open: s = isDraft ? "Draft" : "Open"
        case .merged: s = "Merged"
        case .closed: s = "Closed"
        }
        let c: String? = switch checks {
        case .passing: "checks passing"
        case .failing: "checks failing"
        case .pending: "checks running"
        case .none: nil
        }
        return ["#\(number) \(s)", c].compactMap { $0 }.joined(separator: " · ")
    }

    public static func list(_ v: JSONValue?) -> [PullRequest] {
        (v?.array ?? []).compactMap { p in
            guard let url = p.str("url"), let n = p.long("number") else { return nil }
            return PullRequest(url: url, number: Int(n), title: p.str("title") ?? "", state: State(rawValue: p.str("state") ?? "") ?? .open,
                               isDraft: p.flag("isDraft"), checks: Checks(rawValue: p.str("checks") ?? "") ?? .none,
                               reviewDecision: p.str("reviewDecision"), additions: Int(p.long("additions") ?? 0),
                               deletions: Int(p.long("deletions") ?? 0), changedFiles: Int(p.long("changedFiles") ?? 0))
        }
    }
}

/// Git through the agent: what the PR actions send, as ordinary prompts, so
/// the chat's approvals apply to every command the agent runs for them.
public enum GitPrompt: String, CaseIterable, Sendable {
    case commit, openPr, fixChecks

    public var label: String {
        switch self {
        case .commit: return "Commit these changes"
        case .openPr: return "Open a PR"
        case .fixChecks: return "Fix the failing checks"
        }
    }

    public var text: String {
        switch self {
        case .commit:
            return "Commit the changes you made in this chat with a clear commit message. Don’t push yet."
        case .openPr:
            return "Push this branch and open a pull request for the changes in this chat, with a short description. Then share its link."
        case .fixChecks:
            return "The pull request’s checks are failing. Find out why from the failing runs, fix it, and push the fix."
        }
    }
}

/// The computer's provider usage (`usage:summary`).
public struct UsageSummary: Equatable, Sendable {
    public struct Model: Equatable, Sendable, Identifiable {
        public let model: String
        public let input: Int64
        public let output: Int64
        public let cost: Double
        public let subscription: Bool
        public var id: String { model }
        public var tokens: Int64 { input + output }

        public init(model: String, input: Int64, output: Int64, cost: Double = 0, subscription: Bool = false) {
            self.model = model
            self.input = input
            self.output = output
            self.cost = cost
            self.subscription = subscription
        }
    }

    public struct Day: Equatable, Sendable, Identifiable {
        public let date: String
        public let tokens: Int64
        public let cost: Double
        public var id: String { date }

        public init(date: String, tokens: Int64, cost: Double = 0) {
            self.date = date
            self.tokens = tokens
            self.cost = cost
        }
    }

    public let totalInput: Int64
    public let totalOutput: Int64
    /// What the pay-per-token models cost: the computer counts a subscription's models at zero.
    public let totalCost: Double
    public let models: [Model]
    public let days: [Day]

    public init(totalInput: Int64, totalOutput: Int64, totalCost: Double, models: [Model], days: [Day]) {
        self.totalInput = totalInput
        self.totalOutput = totalOutput
        self.totalCost = totalCost
        self.models = models
        self.days = days
    }

    public var totalTokens: Int64 { totalInput + totalOutput }

    public static func from(_ v: JSONValue?) -> UsageSummary? {
        guard let v, v.object != nil else { return nil }
        let models: [Model] = (v["byModel"]?.array ?? []).compactMap { m in
            m.str("model").map {
                Model(model: $0, input: m.long("input") ?? 0, output: m.long("output") ?? 0, cost: m.dbl("cost") ?? 0,
                      subscription: m.flag("subscription"))
            }
        }
        let days: [Day] = (v["daily"]?.array ?? []).compactMap { d in
            d.str("date").map { Day(date: $0, tokens: (d.long("input") ?? 0) + (d.long("output") ?? 0), cost: d.dbl("cost") ?? 0) }
        }
        return UsageSummary(totalInput: v.long("totalInput") ?? 0, totalOutput: v.long("totalOutput") ?? 0,
                            totalCost: v.dbl("totalCost") ?? 0, models: models, days: days)
    }
}

/// One provider's plan limits (`limits:get`, asked by provider id).
public struct ProviderLimits: Equatable, Sendable {
    public struct Window: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let usedPercent: Double
        public let resetAt: Int64?
        /// `allowed`, `warning` or `rate_limited`.
        public let status: String
        public var limited: Bool { status == "rate_limited" }
    }

    public let planType: String?
    public let windows: [Window]
    public let updatedAt: Int64?

    public static func from(_ v: JSONValue?) -> ProviderLimits? {
        guard let v, v.object != nil else { return nil }
        let windows: [Window] = (v["windows"]?.array ?? []).compactMap { w in
            guard let id = w.str("id") else { return nil }
            return Window(id: id, label: w.str("label") ?? id, usedPercent: min(100, max(0, w.dbl("usedPercent") ?? 0)),
                          resetAt: w.long("resetAt"), status: w.str("status") ?? "allowed")
        }
        return ProviderLimits(planType: v.str("planType"), windows: windows, updatedAt: v.long("updatedAt"))
    }
}

/// Usage from one place it came from (#1773): a paired computer, or this iPhone's
/// own chats. Within a place, subscriptions (plans, with their limits, and the
/// models that bill to them) come before pay-per-token API use.
public struct UsagePlace: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case computer, phone }

    /// A subscription plan: an enabled provider that reported limits.
    public struct Plan: Equatable, Sendable, Identifiable {
        public let providerId: String
        public let label: String
        public let limits: ProviderLimits
        public var id: String { providerId }

        public init(providerId: String, label: String, limits: ProviderLimits) {
            self.providerId = providerId
            self.label = label
            self.limits = limits
        }

        /// The heading: `Claude · Max`.
        public var title: String {
            [label, limits.planType.flatMap { $0.isEmpty ? nil : $0.capitalized }].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// Pay-per-token models, under the provider they bill to when the place knows it
    /// (this iPhone does; a computer's summary names only the model).
    public struct ApiGroup: Equatable, Sendable, Identifiable {
        public let label: String?
        public let models: [UsageSummary.Model]
        public var id: String { label ?? "" }
        public var tokens: Int64 { models.reduce(0) { $0 + $1.tokens } }

        public init(label: String?, models: [UsageSummary.Model]) {
            self.label = label
            self.models = models
        }
    }

    public let id: String
    public let kind: Kind
    /// The computer's name; empty for this iPhone (the app names it).
    public let name: String
    /// The place answered this time. An offline computer keeps the numbers it last gave.
    public var online: Bool
    public var summary: UsageSummary?
    public var plans: [Plan]
    /// This iPhone's API use by provider; a computer's comes from its summary.
    public var phoneGroups: [ApiGroup]
    /// Why the place could not be read, when it could not.
    public var error: String?

    public init(id: String, kind: Kind, name: String, online: Bool, summary: UsageSummary? = nil, plans: [Plan] = [],
                phoneGroups: [ApiGroup] = [], error: String? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.online = online
        self.summary = summary
        self.plans = plans
        self.phoneGroups = phoneGroups
        self.error = error
    }

    /// The place has prices: a computer does. This iPhone has no price table, so it shows tokens only.
    public var priced: Bool { kind == .computer }

    /// The models that bill to a subscription, busiest first.
    public var subscriptionModels: [UsageSummary.Model] { (summary?.models ?? []).filter(\.subscription) }

    /// Pay-per-token use, grouped by provider where the place knows it.
    public var apiGroups: [ApiGroup] {
        if kind == .phone { return phoneGroups.filter { !$0.models.isEmpty } }
        let models = (summary?.models ?? []).filter { !$0.subscription }
        return models.isEmpty ? [] : [ApiGroup(label: nil, models: models)]
    }

    public var totalTokens: Int64 { summary?.totalTokens ?? 0 }
    /// Tokens on a subscription, from the models listed (the computer sends its busiest only).
    public var subscriptionTokens: Int64 { subscriptionModels.reduce(0) { $0 + $1.tokens } }
    public var apiTokens: Int64 { max(0, totalTokens - subscriptionTokens) }
    /// Estimated API spend; nil where the place has no prices.
    public var apiCost: Double? { priced ? summary?.totalCost ?? 0 : nil }
    public var isEmpty: Bool { totalTokens == 0 && plans.isEmpty }
}

/// Every place's usage added up: the All places total at the top.
public struct UsageTotals: Equatable, Sendable {
    public let tokens: Int64
    public let subscriptionTokens: Int64
    public let apiTokens: Int64
    /// Estimated API spend across the computers (this iPhone has no prices).
    public let apiCost: Double
    /// Places whose numbers are not live this time.
    public let offline: Int

    public init(_ places: [UsagePlace]) {
        tokens = places.reduce(0) { $0 + $1.totalTokens }
        subscriptionTokens = places.reduce(0) { $0 + $1.subscriptionTokens }
        apiTokens = places.reduce(0) { $0 + $1.apiTokens }
        apiCost = places.reduce(0) { $0 + ($1.apiCost ?? 0) }
        offline = places.filter { !$0.online }.count
    }
}

/// The chat list's Continue card and search, from the summaries the phone already has.
public enum ChatSearch {
    /// The chat to continue: the most recently active top-level chat that isn't completed.
    public static func continueChat(_ chats: [SessionSummary]) -> SessionSummary? {
        chats.filter { $0.isVisible && !$0.archived }.max { $0.updatedAt < $1.updatedAt }
    }

    /// Chats whose title, first prompt or last reply holds every word of `query`,
    /// ignoring case and accents. Completed chats included, newest first.
    public static func matches(_ chats: [SessionSummary], _ query: String) -> [SessionSummary] {
        let words = fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return chats }
        return chats.filter { s in
            let hay = fold([s.title, s.firstUserText ?? "", s.lastReplyText ?? ""].joined(separator: " "))
            return words.allSatisfy { hay.contains($0) }
        }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }
}
