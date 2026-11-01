import NekkoProtocol
import Observation
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
    /// Reading what was shared: "Don't keep" cancels it, so a slow read can't offer the text after all.
    private var loading: Task<Void, Never>?
    private lazy var inbox = ShareInbox(defaults: UserDefaults(suiteName: Self.appGroup) ?? .standard)

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            done: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            discard: { [weak self] in
                self?.loading?.cancel()
                self?.inbox.clear()
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        loading = Task { await load() }
    }

    private func load() async {
        var text: String?
        var subject: String?
        for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
            // Safari sends the page title with the link.
            subject = subject ?? item.attributedTitle?.string ?? item.attributedContentText?.string
            for provider in item.attachments ?? [] where text == nil {
                text = await Self.text(from: provider)
            }
        }
        // "Don't keep" was tapped while this read: nothing is offered.
        guard !Task.isCancelled else { return }
        guard let prompt = SharedText.from(text: text, subject: subject) else {
            model.state = .nothing
            return
        }
        inbox.offer(prompt)
        model.state = .saved(prompt)
    }

    /// A link, else text: plain, or rich (an app that shares an attributed string
    /// or text as data), through the item provider's typed objects rather than
    /// casting whatever `loadItem` returns.
    private static func text(from provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await read(NSURL.self, provider, { ($0 as? NSURL).map { ($0 as URL).absoluteString } }) {
            return url
        }
        if let s = await read(NSString.self, provider, { ($0 as? NSString).map { $0 as String } }) { return s }
        return await read(NSAttributedString.self, provider, { ($0 as? NSAttributedString)?.string })
    }

    /// One object of `type` from `provider`, turned into a Sendable value inside the callback.
    /// Not generic: the class is only named to the provider, so no metatype crosses into the callback.
    private static func read(_ type: NSItemProviderReading.Type, _ provider: NSItemProvider,
                             _ convert: @escaping @Sendable (any NSItemProviderReading) -> String?) async -> String? {
        guard provider.canLoadObject(ofClass: type) else { return nil }
        return await withCheckedContinuation { (done: CheckedContinuation<String?, Never>) in
            _ = provider.loadObject(ofClass: type) { value, _ in
                done.resume(returning: value.flatMap(convert))
            }
        }
    }
}

@MainActor
@Observable
final class ShareModel {
    enum State: Equatable { case loading, saved(String), nothing }
    var state: State = .loading
}

struct ShareView: View {
    let model: ShareModel
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
