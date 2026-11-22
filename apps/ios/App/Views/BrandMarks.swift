import SwiftUI

/// The companies' own marks, from the asset catalog (vector, the same artwork as the
/// desktop's `providers/*.svg`; see ASSETS.md). Never a stand-in symbol.
enum BrandMarks {
    /// The asset for a provider kind (the ids in `PhoneProviders.kinds`), or nil for a
    /// custom endpoint, which has no mark of its own. Matches the desktop's ProviderMark.tsx.
    static func asset(forProviderKind kind: String) -> String? {
        switch kind {
        case "anthropic", "claude-code", "bedrock", "foundry": return "provider-anthropic"
        case "openai", "chatgpt": return "provider-openai"
        case "gemini", "vertex": return "provider-google"
        case "openrouter": return "provider-openrouter"
        case "ollama", "ollama-cloud": return "provider-ollama"
        case "lmstudio": return "provider-lmstudio"
        case "vllm": return "provider-vllm"
        default: return nil
        }
    }
}

/// A provider's mark in the ink colour, or a plain link glyph for a custom endpoint.
struct ProviderMarkImage: View {
    let kind: String
    var size: CGFloat = 20
    @Environment(\.palette) private var palette
    @ScaledMetric private var scale: CGFloat = 1

    var body: some View {
        Group {
            if let asset = BrandMarks.asset(forProviderKind: kind) {
                Image(asset).renderingMode(.template).resizable().scaledToFit()
            } else {
                Image(systemName: "link").resizable().scaledToFit().padding(size * 0.12)
            }
        }
        .foregroundStyle(palette.ink)
        .frame(width: size * scale, height: size * scale)
        .accessibilityHidden(true)
    }
}

/// A round avatar: a quiet wash with a mark or glyph in it. Space and one wash, no border.
struct AvatarBadge<Content: View>: View {
    var size: CGFloat = 40
    @ViewBuilder var content: () -> Content
    @Environment(\.palette) private var palette
    @ScaledMetric private var scale: CGFloat = 1

    var body: some View {
        content()
            .frame(width: size * scale, height: size * scale)
            .background(palette.surface2, in: Circle())
            .accessibilityHidden(true)
    }
}
