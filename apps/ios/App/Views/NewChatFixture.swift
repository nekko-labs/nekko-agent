#if DEBUG
import NekkoKit
import SwiftUI

/// Real New chat, with an offline draft and no pairing or network side effects.
struct NewChatFixture: View {
    @Environment(ComputersStore.self) private var store
    @State private var path: [Route] = []
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ready {
                NewChatView(path: $path)
            }
        }
        .task {
            store.drafts.set(DraftStore.newChat, Draft(providerId: "fixture", modelId: "claude-opus-5-5"))
            ready = true
        }
    }
}
#endif
