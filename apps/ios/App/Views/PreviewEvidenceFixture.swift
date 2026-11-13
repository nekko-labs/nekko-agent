#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Offline native acceptance for the real reply/card/window/WebKit views (#1095).
/// The synthetic paths/loopback URL are only protocol inputs: no disk or network IO.
@MainActor
struct PreviewEvidenceFixture: View {
    enum Page: String, CaseIterable { case cards = "Cards", server = "Server", table = "Table", unavailable = "Unavailable" }
    @State private var page = Page.cards
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Fixture page", selection: $page) {
                    ForEach(Page.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(12)
                ScrollView {
                    AssistantReply(text: reply, streaming: false, sessionId: "preview-evidence")
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .id(page)
            }
            .background(palette.paper)
            .navigationTitle("Preview evidence")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var reply: String {
        switch page {
        case .cards:
            return """
            ## Review the prototype
            Open [Release prototype](/synthetic/release.html) to try the button.

            Read the [Release notes](/synthetic/notes.md).
            """
        case .server:
            return """
            ## Computer's dev server
            Open the [Local prototype](http://localhost:5173/demo).
            This address is fetched through the preview protocol, not this phone's network.
            """
        case .table:
            return """
            ## Release comparison
            Swipe the table sideways, then expand it.

            | Feature | Native iPhone rendering | Computer-side source | Verification status | Final column |
            | :--- | :--- | :--- | :--- | :--- |
            | HTML prototype | Interactive isolated WebKit preview | Synthetic artifact protocol response | Native interaction fixture | End of wide table |
            | Local server | Same-origin preview scheme | Synthetic preview fetch response | No real network or credentials | End of second row |
            """
        case .unavailable:
            return """
            ## Unavailable files
            Open [Missing notes](/synthetic/missing.md) to see a recoverable error.
            """
        }
    }

    static func read(_ request: PreviewRequest) async throws -> JSONValue {
        guard request.args.first?.string == "preview-evidence" else { throw RelayError("Unknown evidence chat.") }
        let target = request.args.dropFirst().first?.string ?? ""
        if request.channel == PreviewRequest.fetchChannel {
            guard target == "http://localhost:5173/demo" else { throw RelayError("Unexpected preview request.") }
            return ["status": 200, "contentType": "text/html; charset=utf-8", "base64": .string(Data(html.utf8).base64EncodedString())]
        }
        guard request.channel == PreviewRequest.artifactChannel else { throw RelayError("Unexpected evidence channel.") }
        let content: String
        let mime: String
        switch target {
        case "/synthetic/release.html": content = html; mime = "text/html"
        case "/synthetic/notes.md": content = "# Release notes\n\nNative **Markdown preview** loaded from a synthetic computer response."; mime = "text/markdown"
        default: throw RelayError("The file was not found on your computer.", fromComputer: true)
        }
        return ["path": .string(target), "mime": .string(mime), "size": .int(Int64(content.utf8.count)),
                "kind": "text", "content": .string(content), "truncated": false]
    }

    private static let html = """
    <!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#f2f8f6;color:#143d35;font:18px system-ui}h1{font-size:30px}button{font:inherit;background:#146b58;color:white;border:0;border-radius:12px;padding:14px 20px;min-height:48px}p{line-height:1.5}</style>
    <h1>Release prototype</h1><p>Self-contained HTML from a synthetic computer response.</p>
    <button onclick="this.textContent='Prototype confirmed'">Try prototype</button>
    <p>No external scripts, fonts, cookies or credentials.</p></html>
    """
}
#endif
