#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Native evidence only: the real views over an in-memory, signed-call computer.
/// The existing -uiTestNewChat route isolates AppModel from user data/transports.
@MainActor
struct ImageChatFixture: View {
    @State private var store: ComputersStore
    @State private var ready = false
    @State private var opened = false
    @State private var path: [Route] = []

    init() {
        let image = PhotoPreviewFixture.photos[0] // Original synthetic artwork, not a generated/provider image.
        _store = State(initialValue: ComputersStore(store: ImageFixtureSecrets(),
            makeConnection: { _ in ImageFixtureConnection(image: image) },
            deviceName: { "Image evidence iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) }))
    }

    var body: some View {
        NavigationStack {
            if ready {
                if opened { ChatView(sessionId: "image-fixture") }
                else { NewChatView(path: $path, opened: { _ in opened = true }) }
            }
        }
        .environment(store)
        .task {
            guard !ready else { return }
            store.load()
            store.changeSigner = SoftwareChangeSigner()
            if let id = try? await store.pair(PairingLink(relayUrl: "wss://fixture.invalid", room: "a1b2c3d4e5f60718",
                key: "00112233445566778899aabbccddeeff", hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=")) {
                store.rename(id, to: "Image Studio")
            }
            await store.refresh()
            store.drafts.set(DraftStore.newChat, Draft(text: "A mountain under a teal sky"))
            ready = true
        }
    }
}

private final class ImageFixtureSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class ImageFixtureConnection: RemoteConnection, ProofCaller, @unchecked Sendable {
    private let lock = NSLock()
    private let image: String
    private var status: (@Sendable (RelayStatus) -> Void)?
    private var params = ImageChatParams(modelId: "flux-local")
    private var messages: [JSONValue] = []
    init(image: String) { self.image = image }
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?, onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { status = onStatus }
    }
    func connect() { lock.withLock { status }?(RelayStatus(.online)) }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}

    private var session: JSONValue {
        lock.withLock { ["id": "image-fixture", "title": "Local image chat", "chatType": "image", "imageParams": params.json,
                         "messages": .array(messages), "queue": []] }
    }
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        guard channel == Channels.chatGenerateImage else { return try await call(channel, args, timeout: timeout) }
        guard proof != nil else { throw RelayError("Change proof required.") }
        let prompt = args.first?.str("prompt") ?? ""
        lock.withLock {
            messages = [["id": "prompt", "role": "user", "content": .string(prompt)],
                        ["id": "generated", "role": "assistant", "content": "Generated local image (synthetic evidence fixture)", "images": [.string(image)]]]
        }
        return session
    }
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        switch channel {
        case Channels.appInfo:
            return ["capabilities": ["imageGeneration": .bool(!ProcessInfo.processInfo.arguments.contains("-imageOldHost"))]]
        case Channels.engineModels:
            return ProcessInfo.processInfo.arguments.contains("-imageNoModels") ? [] : [["id": "flux-local", "name": "FLUX local", "kind": "image", "format": "gguf", "state": "idle"]]
        case Channels.sessionCreate, Channels.sessionGet: return session
        case Channels.sessionSetOptions:
            if let p = ImageChatParams.from(args.last?["imageParams"]) { lock.withLock { params = p } }
            return session
        case Channels.sessionPhoto: return .string(image)
        case Channels.sessionsSummaries: return [session]
        case Channels.settingsGet: return [:]
        case Channels.chatPending: return [:]
        case ChangeProof.keyChannel: return ["ok": true]
        case Channels.chatGenerateImage: throw RelayError("Use the existing Change proof.")
        case Channels.chatSend, Channels.chatQueue: throw RelayError("Image prompts must never use text routing.")
        default: return .null
        }
    }
}
#endif
