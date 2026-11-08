import Foundation

/// A communication preference for phone-hosted chats, not a permission or replacement identity.
public enum PhoneTone: String, CaseIterable, Codable, Sendable {
    case standard = "Default", friendly = "Friendly", professional = "Professional", concise = "Concise", explanatory = "Explanatory"

    public var instructions: String {
        switch self {
        case .standard: ""
        case .friendly: "Use a warm, approachable tone. Stay honest, clear and concise."
        case .professional: "Use a calm, professional tone with precise, direct language."
        case .concise: "Keep replies brief and focused on the answer, essential caveats and next steps."
        case .explanatory: "Explain the reasoning at a useful level, with clear examples when helpful."
        }
    }

    public var systemPrompt: String {
        instructions.isEmpty ? PhoneProviders.system : PhoneProviders.system + "\n\nCommunication preference: " + instructions
    }
}
