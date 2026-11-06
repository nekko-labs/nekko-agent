#if DEBUG
import NekkoProtocol
import SwiftUI

/// UI-test fixture (`-uiTestMarkdownLab`, Debug builds only): a reply and the
/// user's own messages drawn by the chat's real `BlockView`, and the chat's
/// real message box, so the Markdown rendering and the formatting toolbar can
/// be exercised and photographed without a paired computer. Send puts the
/// draft in a bubble and echoes it back as a reply.
struct MarkdownLab: View {
    @Environment(\.palette) private var palette
    @State private var sent: [String] = [MarkdownLab.userMessage]
    @State private var echoes: [String] = []
    @State private var draft = ""
    @State private var focused = false
    /// `-labDiagrams`: the Mermaid fixtures first, with the renderer's timings and network probe.
    private let diagramsFirst = ProcessInfo.processInfo.arguments.contains("-labDiagrams")
    @State private var timings = ""
    @State private var network = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if diagramsFirst {
                        BlockView(block: .assistant(id: "lab-diagrams", text: Self.diagrams, reasoning: nil, streaming: false, interrupted: false))
                        Text("Renderer network: \(network)").font(.caption2).accessibilityIdentifier("lab.mermaidNetwork")
                        Text("Render times (ms): \(timings)").font(.caption2).accessibilityIdentifier("lab.mermaidTimes")
                    }
                    BlockView(block: .assistant(id: "lab-reply", text: Self.reply, reasoning: nil, streaming: false, interrupted: false))
                        .id("lab-reply")
                    ForEach(Array(sent.enumerated()), id: \.offset) { i, text in
                        BlockView(block: .user(id: "lab-user-\(i)", text: text, at: nil, images: 0))
                            .accessibilityIdentifier("lab.sent.\(i)")
                    }
                    ForEach(Array(echoes.enumerated()), id: \.offset) { i, text in
                        BlockView(block: .assistant(id: "lab-echo-\(i)", text: text, reasoning: nil, streaming: false, interrupted: false))
                            .id("lab-echo-\(i)")
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(palette.paper)
            .safeAreaInset(edge: .bottom) {
                HStack(alignment: .bottom, spacing: 8) {
                    MarkdownComposerField(text: $draft, focused: $focused, placeholder: "Message")
                    Button {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        sent.append(text)
                        echoes.append(text)
                        draft = ""
                        focused = false
                    } label: {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 36, height: 36)
                            .background(palette.accent, in: Circle()).foregroundStyle(palette.onAccent)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Send")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(.bar)
            }
            .navigationTitle("Markdown")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task {
            guard diagramsFirst else { return }
            network = await MermaidRenderer.shared.networkProbe()
            while !Task.isCancelled {
                timings = MermaidRenderer.shared.timings.map { String(format: "%.0f", $0) }.joined(separator: ", ")
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    static let diagrams = """
    A flowchart:

    ```mermaid
    flowchart TD
      A[Phone] -->|types Markdown| B(Composer)
      B --> C{Send?}
      C -->|yes| D[Computer]
      C -->|no| B
    ```

    A sequence:

    ```mermaid
    sequenceDiagram
      participant P as Phone
      participant R as Relay
      participant C as Computer
      P->>R: encrypted prompt
      R->>C: forward
      C-->>P: streamed reply
    ```

    And a broken one:

    ```mermaid
    flowchart TD
      A -->
      this is not mermaid ((
    ```
    """

    static let reply = """
    ## Release checklist

    Here is where things stand, with **bold**, *italic*, ~~struck~~ and `inline code`.

    1. Build the phone app
       - Run the protocol tests
         - on Linux
         - on macOS
       - Archive for TestFlight
    2. Check the relay
       1. health endpoint
       2. a paired round trip
    3. Ship it

    - [x] Parser
    - [ ] Toolbar
      that wraps onto a second line under its text

    | Name | Status | Count |
    |:-----|:------:|------:|
    | Nekko | **done** | 3 |
    | Relay | open | 12 |
    | Local Web UI | in review | 7 |

    | Area | Owner | Platform | Status | Notes | Due |
    |------|-------|----------|--------|-------|-----|
    | Composer | Philip | iOS | building | The toolbar sits inside the composer card, above the text | Nov |
    | Tables | Philip | iOS | review | Wide tables scroll sideways in their own frame | Nov |
    | Android | — | Android | planned | MD-6 | Dec |

    > A quote with a list:
    > - first
    > - second

    ```swift
    let blocks = MarkdownParser.blocks(text)
    ```
    """

    static let userMessage = """
    Can you also check:
    - the **relay** logs
      - from yesterday
    - `nekkod` memory
    """
}
#endif
