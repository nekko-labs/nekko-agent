import NekkoProtocol
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Nekko Agent" in the share sheet: text or a link from any app becomes the
/// first message of a new chat. The extension only cleans the text and leaves
/// it in the App Group (`ShareInbox`); the app picks it up the next time it
/// comes to the front and opens New chat with it, editable. Nothing is sent
/// from here, and the extension never connects to the computer.
final class ShareViewController: UIViewController {
    static let appGroup = "group.dev.nekkolabs.nekkoagent"

    private let model = ShareModel()
    private lazy var inbox = ShareInbox(defaults: UserDefaults(suiteName: Self.appGroup) ?? .standard)

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            done: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            discard: { [weak self] in
                self?.inbox.clear()
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await load() }
    }

    private func load() async {
        var text: String?
        var subject: String?
        for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
            // Safari sends the page title with the link.
            subject = subject ?? item.attributedTitle?.string ?? item.attributedContentText?.string
            for provider in item.attachments ?? [] where text == nil {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    text = url.absoluteString
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = s
                }
            }
        }
        guard let prompt = SharedText.from(text: text, subject: subject) else {
            model.state = .nothing
            return
        }
        inbox.offer(prompt)
        model.state = .saved(prompt)
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum State: Equatable { case loading, saved(String), nothing }
    @Published var state: State = .loading
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    var done: () -> Void
    var discard: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch model.state {
                case .loading:
                    ProgressView()
                case .saved(let text):
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(text)
                                .font(.callout)
                                .lineLimit(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                            Label("Open Nekko Agent and New chat starts with this. Nothing is sent until you press Start.",
                                  systemImage: "bubble.left.and.text.bubble.right")
                                .font(.subheadline)
                            Text("It waits for 10 minutes, on this iPhone only.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(20)
                    }
                case .nothing:
                    Text("There’s no text or link here to start a chat with.")
                        .multilineTextAlignment(.center).padding(24)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Nekko Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.state == .nothing ? "Close" : "Don’t keep", action: discard)
                }
                if case .saved = model.state {
                    ToolbarItem(placement: .confirmationAction) { Button("Done", action: done).bold() }
                }
            }
        }
    }
}
