import Foundation

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

    var label: String {
        switch self {
        case .show: return String(localized: "Show")
        case .expert: return String(localized: "Expert only")
        case .hide: return String(localized: "Hide")
        }
    }
}

struct SimpleItem: Identifiable, Equatable {
    let id: String
    /// The screen and area it sits in, as Settings groups it.
    let area: String
    let label: String
    let hint: String
    let fallback: SimpleVisibility
}

enum SimpleMode {
    static let items: [SimpleItem] = [
        SimpleItem(id: "changes", area: String(localized: "Chat · header"), label: String(localized: "Changes"),
                   hint: String(localized: "Review the files the agent changed"), fallback: .expert),
        SimpleItem(id: "hardware", area: String(localized: "Chat · header"), label: String(localized: "Hardware strip"),
                   hint: String(localized: "CPU, memory and GPU dials under the title"), fallback: .expert),
        SimpleItem(id: "ph-subtitle", area: String(localized: "Chat · header"), label: String(localized: "Model and computer under the title"),
                   hint: String(localized: "Like “Opus 5.5 · Studio Mac”"), fallback: .expert),
        SimpleItem(id: "model", area: String(localized: "Chat · message box"), label: String(localized: "Model name and picker"),
                   hint: String(localized: "Switch between Claude, ChatGPT or a local model"), fallback: .show),
        SimpleItem(id: "effort", area: String(localized: "Chat · message box"), label: String(localized: "Effort"),
                   hint: String(localized: "How hard the model thinks before it answers"), fallback: .expert),
        SimpleItem(id: "context", area: String(localized: "Chat · message box"), label: String(localized: "Context ring and token count"),
                   hint: String(localized: "How full this chat is, in tokens"), fallback: .expert),
        SimpleItem(id: "ph-policy", area: String(localized: "Chat · message box"), label: String(localized: "Tool policy"),
                   hint: String(localized: "Ask, Guardrails or YOLO, in the More menu and New chat"), fallback: .expert),
        SimpleItem(id: "thinking", area: String(localized: "Chat · conversation"), label: String(localized: "Reasoning and tool steps"),
                   hint: String(localized: "What the model thought, and each step it took"), fallback: .expert),
        SimpleItem(id: "ph-git", area: String(localized: "Chat · conversation"), label: String(localized: "Git and pull requests"),
                   hint: String(localized: "Commits, PR cards and the PR dock"), fallback: .expert),
        SimpleItem(id: "terminal", area: String(localized: "Agents wall"), label: String(localized: "Terminal"),
                   hint: String(localized: "Open a terminal from New or the More menu"), fallback: .expert),
        SimpleItem(id: "ph-monitors", area: String(localized: "Phone · chats list"), label: String(localized: "Monitors row"),
                   hint: String(localized: "Hardware and loaded models at the top of Chats"), fallback: .expert),
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

    /// Whether an item is on screen in the given mode.
    static func shown(_ id: String, expert: Bool, _ choices: [String: SimpleVisibility]) -> Bool {
        let v = visibility(id, choices)
        return v == .show || (v == .expert && expert)
    }

    /// Saved choices, keeping only known ids with valid values that differ from the default. Never throws.
    static func parse(_ raw: String?) -> [String: SimpleVisibility] {
        guard let data = raw?.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        var out: [String: SimpleVisibility] = [:]
        for (id, value) in object {
            guard let item = byId[id], let v = (value as? String).flatMap(SimpleVisibility.init(rawValue:)), v != item.fallback else { continue }
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
