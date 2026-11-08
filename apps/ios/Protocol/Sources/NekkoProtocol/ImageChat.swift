import Foundation

/// The local diffusion turn's wire parameters (shared/chat.ts). No provider or file paths.
public struct ImageChatParams: Equatable, Sendable, Codable {
    public var modelId: String?
    public var width = 1024
    public var height = 1024
    public var steps = 28
    // Existing Change proofs accept safe integers only. Do not silently round
    // a fractional CFG read from a desktop-created image session.
    public var cfgScale = 4.0
    public var seed: Int64 = -1

    public init(modelId: String? = nil) { self.modelId = modelId }

    public static func from(_ v: JSONValue?) -> ImageChatParams? {
        guard let v, v.object != nil else { return nil }
        var p = ImageChatParams(modelId: v.str("modelId"))
        p.width = Int(v.long("width") ?? 1024)
        p.height = Int(v.long("height") ?? 1024)
        p.steps = Int(v.long("steps") ?? 28)
        p.cfgScale = v.dbl("cfgScale") ?? 4.5
        p.seed = v.long("seed") ?? -1
        return p
    }

    public var valid: Bool {
        (256...2048).contains(width) && width % 64 == 0
            && (256...2048).contains(height) && height % 64 == 0
            && (1...100).contains(steps) && cfgScale.isFinite && cfgScale == cfgScale.rounded() && (0...30).contains(cfgScale)
            && (-1...2_147_483_647).contains(seed)
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["width": .int(Int64(width)), "height": .int(Int64(height)),
            "steps": .int(Int64(steps)), "cfgScale": .double(cfgScale), "seed": .int(seed)]
        if let modelId { o["modelId"] = .string(modelId) }
        return .object(o)
    }

    public var sessionOptions: JSONValue { .object(["chatType": .string("image"), "imageParams": json]) }
    public func generation(sessionId: String, prompt: String) -> JSONValue {
        .object(["sessionId": .string(sessionId), "prompt": .string(prompt), "params": json])
    }
}

/// Only the safe, local image-model projection of engine:models is retained.
/// Never infer generation support from a name or from vision-input support.
public struct ImageChatModel: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let format: String?
    public let state: String?

    public static func list(_ v: JSONValue?) -> [ImageChatModel] {
        (v?.array ?? []).compactMap { m in
            guard let id = m.str("id"), !id.isEmpty,
                  m.str("modality") == "image" || m.str("kind") == "image" else { return nil }
            return ImageChatModel(id: id, name: m.str("name") ?? id, format: m.str("format"), state: m.str("state"))
        }
    }
}
