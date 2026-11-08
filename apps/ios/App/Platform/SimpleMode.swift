import Foundation
import NekkoProtocol

/// Simple and Expert (spec desktop/desktop-simple-and-expert-modes): the
/// controls each mode shows on the phone. The phone's part of the desktop's
/// list in packages/shared/src/simple-mode.ts; keep the ids in step.
enum SimpleVisibility: String, CaseIterable, Codable {
    /// In both modes.
    case show
    /// In Expert only.
    case expert
    /// In neither.
    case hide
    /// In both modes, but only while its condition holds.
    case auto

    /// What Settings calls this choice. Show pins a monitor on, so it reads Always there.
    func label(for item: SimpleItem) -> String {
        switch self {
        case .auto: return String(localized: "When running")
        case .show: return item.fallback == .auto ? String(localized: "Always") : String(localized: "Show")
        case .expert: return String(localized: "Detailed only")
        case .hide: return String(localized: "Hide")
        }
    }
}

/// What is true right now that can make a control relevant.
struct SimpleContext {
    /// A local model runs on the computer this phone is connected to.
    var localModel = false
    /// This chat has changed files.
    var changes = false
    /// This chat has a pull request.
    var pr = false

    func holds(_ condition: SimpleCondition) -> Bool {
        switch condition {
        case .localModel: return localModel
        case .changes: return changes
        case .pr: return pr
        }
    }
}

enum SimpleCondition: Equatable {
    case localModel, changes, pr
}

struct SimpleItem: Identifiable, Equatable {
    let id: String
    /// The screen and area it sits in, as Settings groups it.
    let area: String
    let label: String
    let hint: String
    let fallback: SimpleVisibility
    /// It has nothing to show without this, in any mode and whatever is chosen.
    var needs: SimpleCondition? = nil
    /// What an `auto` control waits for.
    var when: SimpleCondition? = nil
}

enum SimpleMode {
    static let items: [SimpleItem] = [
        SimpleItem(id: "changes", area: String(localized: "Chat · header"), label: String(localized: "Changes"),
                   hint: String(localized: "Says how many files the agent changed. Only while this chat has changed files"), fallback: .show, needs: .changes),
        SimpleItem(id: "hardware", area: String(localized: "Chat · header"), label: String(localized: "Hardware strip"),
                   hint: String(localized: "CPU, memory and GPU dials under the title"), fallback: .auto, when: .localModel),
        SimpleItem(id: "ph-subtitle", area: String(localized: "Chat · header"), label: String(localized: "Model and computer under the title"),
                   hint: String(localized: "Like “Opus 5.5 · Studio Mac”"), fallback: .expert),
        SimpleItem(id: "model", area: String(localized: "Chat · message box"), label: String(localized: "Model name and picker"),
                   hint: String(localized: "Switch between Claude, ChatGPT or a local model"), fallback: .show),
        SimpleItem(id: "effort", area: String(localized: "Chat · message box"), label: String(localized: "Effort"),
                   hint: String(localized: "How hard the model thinks before it answers. Inside the model menu in Simple"), fallback: .show),
        SimpleItem(id: "asks", area: String(localized: "Chat · message box"), label: String(localized: "Always ask"),
                   hint: String(localized: "When the agent stops to ask you, in plain words"), fallback: .show),
        SimpleItem(id: "context", area: String(localized: "Chat · message box"), label: String(localized: "Context ring and token count"),
                   hint: String(localized: "How full this chat is, in tokens"), fallback: .show),
        SimpleItem(id: "run-settings", area: String(localized: "Chat · message box"), label: String(localized: "Run settings"),
                   hint: String(localized: "Offline, incognito, Git branch and tool style, in the model menu"), fallback: .expert),
        SimpleItem(id: "thinking", area: String(localized: "Chat · conversation"), label: String(localized: "Reasoning and tool steps"),
                   hint: String(localized: "What the model thought, and each step it took"), fallback: .expert),
        SimpleItem(id: "pr-status", area: String(localized: "Chat · conversation"), label: String(localized: "Pull request status"),
                   hint: String(localized: "The PR chip. Only while this chat has a pull request"), fallback: .show, needs: .pr),
        SimpleItem(id: "ph-git", area: String(localized: "Chat · conversation"), label: String(localized: "Git"),
                   hint: String(localized: "The Git screen and commits"), fallback: .expert),
        SimpleItem(id: "ph-monitors", area: String(localized: "Phone · chats list"), label: String(localized: "Monitors row"),
                   hint: String(localized: "Hardware and loaded models at the top of Chats"), fallback: .auto, when: .localModel),
    ]

    private static let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })

    /// The items grouped by area, in catalogue order.
    static var areas: [(area: String, items: [SimpleItem])] {
        var out: [(area: String, items: [SimpleItem])] = []
        for item in items {
            if let i = out.firstIndex(where: { $0.area == item.area }) { out[i].items.append(item) } else { out.append((item.area, [item])) }
        }
        return out
    }

    /// Where an item shows, after the person's choice. Unknown ids always show.
    static func visibility(_ id: String, _ choices: [String: SimpleVisibility]) -> SimpleVisibility {
        guard let item = byId[id] else { return .show }
        return choices[id] ?? item.fallback
    }

    /// The choices an item offers. Show pins an `auto` control on, so it takes the place of Expert only.
    static func options(_ item: SimpleItem) -> [SimpleVisibility] {
        item.fallback == .auto ? [.auto, .show, .hide] : [.show, .expert, .hide]
    }

    /// Whether an item is on screen now, as `simpleShown` decides on the desktop. Hide always wins, `needs`
    /// is required in every mode, `auto` waits for its condition, and Expert only stays for Expert.
    static func shown(_ id: String, expert: Bool, _ choices: [String: SimpleVisibility], context: SimpleContext = SimpleContext()) -> Bool {
        let v = visibility(id, choices)
        if v == .hide { return false }
        if let needs = byId[id]?.needs, !context.holds(needs) { return false }
        if v == .auto { return byId[id]?.when.map(context.holds) ?? false }
        return v == .show || expert
    }

    /// "3 files changed".
    static func filesChanged(_ count: Int) -> String {
        count == 1 ? String(localized: "1 file changed") : String(localized: "\(count) files changed")
    }

    /// The tool policy in plain words, as Simple shows it. Same values as the computer's own.
    static func asksName(_ mode: PcSettings.ChatMode) -> String {
        switch mode {
        case .ask: return String(localized: "Always ask")
        case .guardrails: return String(localized: "Ask when it matters")
        case .yolo: return String(localized: "No restrictions")
        }
    }

    /// Simple's "this chat is getting long" note: from 85% of the window, the
    /// conversation's tokens that starting fresh would save; nil below that.
    static func longChatSaving(_ context: ContextUsage?, used: Int64?) -> Int64? {
        guard let context, let window = context.contextWindow, window > 0 else { return nil }
        let inUse = max(used ?? 0, context.usedTokens)
        guard Double(inUse) >= Double(window) * 0.85 else { return nil }
        let conversation = context.sources.first { $0.source == "conversation" }?.tokens ?? 0
        return conversation > 0 ? conversation : nil
    }

    /// Saved choices, keeping only known ids with valid values that differ from the default. Never throws.
    static func parse(_ raw: String?) -> [String: SimpleVisibility] {
        guard let data = raw?.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        var out: [String: SimpleVisibility] = [:]
        for (id, value) in object {
            guard let item = byId[id], let v = (value as? String).flatMap(SimpleVisibility.init(rawValue:)), options(item).contains(v), v != item.fallback else { continue }
            out[id] = v
        }
        return out
    }

    /// The JSON saved in Prefs: only the choices that differ from the default.
    static func encode(_ choices: [String: SimpleVisibility]) -> String {
        let kept = choices.filter { id, v in byId[id].map { $0.fallback != v } ?? false }
        let data = (try? JSONSerialization.data(withJSONObject: kept.mapValues(\.rawValue), options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
