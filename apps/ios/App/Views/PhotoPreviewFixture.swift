#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The real composers and chat, backed by an in-memory computer. No relay,
/// credentials, provider requests or persisted user data are used.
struct PhotoPreviewFixture: View {
    @State private var store = ComputersStore(store: PhotoFixtureSecrets(), makeConnection: { _ in PhotoFixtureConnection() },
                                              deviceName: { "Photo preview test" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) })
    @State private var ready = false
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack {
            if ready {
                if ProcessInfo.processInfo.arguments.contains("-photoNewChat") {
                    NewChatView(path: $path)
                } else {
                    ChatView(sessionId: "photo-fixture")
                }
            }
        }
        .environment(store)
        .task {
            store.load()
            try? await store.pair(PairingLink(relayUrl: "wss://fixture.invalid", room: "a1b2c3d4e5f60718",
                                            key: "00112233445566778899aabbccddeeff",
                                            hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            await store.refresh()
            let args = ProcessInfo.processInfo.arguments
            let photos = args.contains("-duplicatePhotos") ? [Self.photos[0], Self.photos[0]] : Self.photos
            let draft = Draft(text: args.contains("-photoOnly") ? "" : "Here are the photos. What do you see?", images: photos, providerId: "fixture", modelId: "fixture")
            store.drafts.set("photo-fixture", draft)
            store.drafts.set(DraftStore.newChat, draft)
            ready = true
        }
    }

    /// Original test artwork, deliberately distinct so order/removal is visible.
    static var photos: [String] {
        [UIColor.systemTeal, UIColor.systemOrange].enumerated().map { i, color in
            let image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 240)).image { ctx in
                color.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
                UIImage(systemName: i == 0 ? "mountain.2.fill" : "sun.max.fill")?
                    .withTintColor(.white, renderingMode: .alwaysOriginal)
                    .draw(in: CGRect(x: 96, y: 56, width: 128, height: 128))
            }
            return "data:image/jpeg;base64," + image.jpegData(compressionQuality: 0.8)!.base64EncodedString()
        }
    }
}

private final class PhotoFixtureSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class PhotoFixtureConnection: RemoteConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var status: (@Sendable (RelayStatus) -> Void)?
    private var event: (@Sendable (String, JSONValue) -> Void)?
    private var messages: [JSONValue] = []
    private var ids: [JSONValue] = []

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { status = onStatus; event = onEvent }
    }
    func connect() { lock.withLock { status }?(RelayStatus(.online)) }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        switch channel {
        case Channels.settingsGet: return ["defaultProviderId": "fixture", "defaultModelId": "fixture"]
        case Channels.chatPending: return [:]
        case Channels.sessionGet:
            return lock.withLock { ["id": "photo-fixture", "title": "Photo previews", "providerId": "fixture", "modelId": "fixture",
                                    "messages": .array(messages), "queue": [], "clientMessageIds": .array(ids)] }
        case Channels.chatSend:
            let prompt = args.first ?? .null
            lock.withLock {
                messages = [["id": "saved-photo", "role": "user", "content": .string(prompt.str("text") ?? ""), "images": prompt["images"] ?? []],
                            ["id": "saved-reply", "role": "assistant", "content": "A mountain and a sun."]]
                ids = [prompt["clientMessageId"] ?? .null]
            }
            let callback = lock.withLock { event }
            callback?("agent:event", ["type": "text", "sessionId": "photo-fixture", "delta": "A mountain and a sun."])
            callback?("agent:event", ["type": "done", "sessionId": "photo-fixture"])
            return .null
        default: return .null
        }
    }
}
#endif
