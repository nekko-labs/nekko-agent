import AppIntents
import Foundation
import NekkoKit
import NekkoProtocol

/// "Ask my computer" for Shortcuts, Siri and Spotlight: starts a chat on the
/// active computer with its default model and opens it, so a run can be
/// kicked off hands-free. The phone's app lock still applies when it opens.
struct AskComputerIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask my computer"
    static var description = IntentDescription("Start a chat with Nekko Agent on your computer.")
    static var openAppWhenRun = true

    @Parameter(title: "Message", requestValueDialog: "What should your computer do?")
    var message: String

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let app = AppModel.shared
        app.start(force: true)
        guard let id = try await app.startChat(message) else {
            return .result(dialog: "Pair a computer in Nekko Agent first.")
        }
        app.openChat = id
        return .result(dialog: "Started on \(app.store.active?.name ?? "your computer").")
    }
}

/// "What needs me?": how many chats wait on you and how many are working,
/// answered from the widget's counts-only snapshot without opening the app,
/// so it says nothing the Home Screen widget wouldn't.
struct NeedsYouIntent: AppIntent {
    static var title: LocalizedStringResource = "What needs me?"
    static var description = IntentDescription("Hear how many chats on your computer need you or are working. Counts only.")
    static var openAppWhenRun = false

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: "\(StatusSnapshot.load().spoken())")
    }
}

struct NekkoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskComputerIntent(),
                    phrases: ["Ask my computer with \(.applicationName)", "Start a \(.applicationName) chat"],
                    shortTitle: "Ask my computer",
                    systemImageName: "desktopcomputer")
        AppShortcut(intent: NeedsYouIntent(),
                    phrases: ["What needs me in \(.applicationName)", "Check \(.applicationName)"],
                    shortTitle: "What needs me?",
                    systemImageName: "hand.raised")
    }
}

extension AppModel {
    /// A new chat on the active computer with its default model and `text` as
    /// the first message. Nil when no computer is paired.
    func startChat(_ text: String) async throws -> String? {
        guard !store.computers.isEmpty else { return nil }
        let deadline = Date().addingTimeInterval(12)
        while store.conn != .online {
            if store.conn == .denied { throw RelayError("This phone is no longer paired.") }
            if Date() > deadline { throw RelayError("Couldn’t reach \(store.active?.name ?? "your computer").") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        // The defaults arrive with the first refresh after connecting.
        if store.defaults.defaultModelId == nil { await store.refresh() }
        var provider = store.defaults.defaultProviderId
        var model = store.defaults.defaultModelId
        if let id = store.activeId, let last = prefs.lastModel[id], let r = last.range(of: "::") {
            provider = String(last[..<r.lowerBound])
            model = String(last[r.upperBound...])
        }
        guard let provider, let model, model != autoModelId else { throw RelayError("Choose a default model on your computer first.") }
        let id = try await store.createChat(providerId: provider, modelId: model, workspaceId: nil, mode: nil)
        let chat = ChatModel(sessionId: id, store: store)
        await chat.reload()
        try await chat.send(text)
        return id
    }
}
