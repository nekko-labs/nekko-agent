import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The rules for drawing a ```` ```mermaid ```` fence on the phone (MM-1, MM-2),
/// kept apart from the WebKit renderer so they are tested on Linux: which
/// fences are diagrams, when one may be drawn, the size cap, and the cache key.
public enum MermaidRules {
    /// Longer sources fall back to their code with "Too large to draw on the phone".
    public static let maxSource = 50_000
    /// A render that takes longer than this falls back the same way.
    public static let timeout: TimeInterval = 5
    /// Rendered widths are rounded down to steps of this many points, so a
    /// rotation or a split view does not draw every diagram again.
    public static let widthStep = 40

    public enum Decision: Equatable, Sendable {
        /// The fence is closed and small enough: draw it.
        case draw
        /// A streaming reply has not closed the fence yet: show the source, draw later.
        case waitForFence
        case tooLarge
    }

    /// A fence's language says Mermaid (```` ```mermaid ````, any case).
    public static func isMermaid(language: String) -> Bool {
        let l = language.lowercased()
        return l == "mermaid" || l == "mmd"
    }

    /// `.mmd` and `.mermaid` files opened from Files.
    public static func isMermaidFile(_ name: String) -> Bool {
        let l = name.lowercased()
        return l.hasSuffix(".mmd") || l.hasSuffix(".mermaid")
    }

    /// What to do with a Mermaid fence. Never draw before the fence closes,
    /// so a streaming reply renders the diagram once, not once per token.
    public static func decide(source: String, closed: Bool) -> Decision {
        guard closed else { return .waitForFence }
        return source.utf16.count > maxSource ? .tooLarge : .draw
    }

    /// The width a diagram is drawn at for a space `width` points wide.
    public static func drawWidth(_ width: Double) -> Int {
        max(widthStep, Int(width) / widthStep * widthStep)
    }

    /// The cache key for one drawing: the source, the theme and the width step
    /// (and the renderer's version, so a new bundled Mermaid draws afresh).
    public static func cacheKey(source: String, dark: Bool, width: Int, version: String) -> String {
        let material = "mermaid|\(version)|\(dark ? "dark" : "light")|\(width)|\(source)"
        return SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The diagram's kind for VoiceOver ("Diagram, flowchart"), from its first keyword.
    public static func kind(_ source: String) -> String {
        let first = source.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("%%") && $0 != "---" } ?? ""
        let word = String(first.split(separator: " ").first ?? "").lowercased()
        let names: [String: String] = [
            "graph": "flowchart", "flowchart": "flowchart", "sequencediagram": "sequence diagram",
            "classdiagram": "class diagram", "statediagram": "state diagram", "statediagram-v2": "state diagram",
            "erdiagram": "entity relationship diagram", "gantt": "Gantt chart", "pie": "pie chart",
            "journey": "user journey", "gitgraph": "git graph", "mindmap": "mind map", "timeline": "timeline",
            "quadrantchart": "quadrant chart", "xychart-beta": "chart", "sankey-beta": "Sankey diagram",
            "requirementdiagram": "requirement diagram", "c4context": "C4 diagram", "block-beta": "block diagram",
            "architecture-beta": "architecture diagram", "kanban": "kanban board", "packet-beta": "packet diagram",
        ]
        return names[word] ?? "diagram"
    }
}
