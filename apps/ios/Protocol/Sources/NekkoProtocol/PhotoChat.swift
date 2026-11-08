import Foundation

// Photo chats (`chatType == "image"`): a prompt goes to a picture model on the
// computer (`chat:generateImage`, decision 0069) and the reply is the picture.
// Ports of `ImageChatParams` / `GeneratedImageMeta` (shared/chat.ts) and the
// desktop's photoEdit.ts (decision 0067: an attached photo means edit).

/// A Photo chat's picture settings (`Session.imageParams`), with the desktop's
/// defaults (`DEFAULT_IMAGE_CHAT_PARAMS`) for any it doesn't say.
public struct ImageParams: Equatable, Sendable {
    /// The picture model on the computer; nil until one is chosen there.
    public var modelId: String?
    public var width: Int64 = 1024
    public var height: Int64 = 1024
    public var steps: Int64 = 28
    public var cfgScale: Double = 4.5
    /// -1 picks a fresh random seed per picture.
    public var seed: Int64 = -1

    public init(modelId: String? = nil, width: Int64 = 1024, height: Int64 = 1024, steps: Int64 = 28, cfgScale: Double = 4.5, seed: Int64 = -1) {
        self.modelId = modelId
        self.width = width
        self.height = height
        self.steps = steps
        self.cfgScale = cfgScale
        self.seed = seed
    }

    public static func from(_ v: JSONValue?) -> ImageParams? {
        guard let v, v.object != nil else { return nil }
        var p = ImageParams()
        p.modelId = v.str("modelId").flatMap { $0.isEmpty ? nil : $0 }
        if let n = v.long("width"), n > 0 { p.width = n }
        if let n = v.long("height"), n > 0 { p.height = n }
        if let n = v.long("steps"), n > 0 { p.steps = n }
        if let n = v.dbl("cfgScale") { p.cfgScale = n }
        if let n = v.long("seed") { p.seed = n }
        return p
    }

    /// The `params` of a turn: only `PHONE_IMAGE_PARAM_KEYS`. Nil without a model.
    public var json: JSONValue? {
        guard let modelId else { return nil }
        return ["modelId": .string(modelId), "width": .int(width), "height": .int(height), "steps": .int(steps),
                "cfgScale": .double(cfgScale), "seed": .int(seed)]
    }
}

/// How a reply's picture was made (`GeneratedImageMeta`). A clip (`video`) is
/// an animated picture from a video model: it is not offered for editing.
public struct GeneratedPicture: Equatable, Sendable {
    public let modelId: String?
    public let width: Int64?
    public let height: Int64?
    public let seed: Int64?
    public let ms: Int64?
    public let isClip: Bool

    public init(modelId: String? = nil, width: Int64? = nil, height: Int64? = nil, seed: Int64? = nil, ms: Int64? = nil, isClip: Bool = false) {
        self.modelId = modelId
        self.width = width
        self.height = height
        self.seed = seed
        self.ms = ms
        self.isClip = isClip
    }

    public static func from(_ v: JSONValue?) -> GeneratedPicture? {
        guard let v, v.object != nil else { return nil }
        return GeneratedPicture(modelId: v.str("modelId"), width: v.long("width"), height: v.long("height"),
                                seed: v.long("seed"), ms: v.long("ms"), isClip: v["video"].map { !$0.isNull } ?? false)
    }
}

public struct PixelSize: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// The desktop's photoEdit.ts: what a Photo chat sends to edit.
public enum PhotoEdit {
    /// At most this many pictures to edit from (the engine and the phone gate refuse more).
    public static let maxPhotos = 4
    /// A photo's longest side once attached.
    public static let maxEdge = 1536
    /// The photo types the phone gate takes (`data:image/png|jpeg|webp;base64,`).
    public static let types = ["image/png", "image/jpeg", "image/webp"]

    /// `fitWithin`: scaled so the longest side is at most `max`, never enlarged.
    public static func fit(_ size: PixelSize, max edge: Int = maxEdge) -> PixelSize {
        let longest = Swift.max(size.width, size.height)
        guard longest > edge, longest > 0 else { return size }
        let scale = Double(edge) / Double(longest)
        return PixelSize(width: Swift.max(1, Int((Double(size.width) * scale).rounded())),
                         height: Swift.max(1, Int((Double(size.height) * scale).rounded())))
    }

    private static func snap(_ n: Double) -> Int64 { Swift.min(2048, Swift.max(256, Int64((n / 64).rounded()) * 64)) }

    /// `editSize`: the photo's shape with about as many pixels as the chat's
    /// chosen size, in the multiples of 64 the engine accepts (256-2048).
    public static func editSize(photo: PixelSize, chosen: ImageParams) -> (width: Int64, height: Int64) {
        guard photo.width > 0, photo.height > 0 else { return (chosen.width, chosen.height) }
        let area = Double(chosen.width * chosen.height)
        let ratio = Double(photo.width) / Double(photo.height)
        return (snap((area * ratio).squareRoot()), snap((area / ratio).squareRoot()))
    }

    /// Whether the computer's gate takes this as a photo to edit.
    public static func accepts(_ dataURL: String) -> Bool {
        types.contains { dataURL.hasPrefix("data:\($0);base64,") }
    }

    /// A data URL's pixel size from its PNG, JPEG or WebP header; nil when it can't be read.
    public static func size(of dataURL: String) -> PixelSize? {
        guard let comma = dataURL.firstIndex(of: ","), dataURL.hasPrefix("data:"),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]), options: .ignoreUnknownCharacters)
        else { return nil }
        return size(of: [UInt8](data))
    }

    static func size(of b: [UInt8]) -> PixelSize? {
        func be16(_ i: Int) -> Int { Int(b[i]) << 8 | Int(b[i + 1]) }
        func be32(_ i: Int) -> Int { be16(i) << 16 | be16(i + 2) }
        func le16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
        func le24(_ i: Int) -> Int { le16(i) | Int(b[i + 2]) << 16 }
        // PNG: the IHDR chunk right after the signature.
        if b.count >= 24, b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 {
            return PixelSize(width: be32(16), height: be32(20))
        }
        // JPEG: the first start-of-frame marker.
        if b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 {
            var i = 2
            while i + 9 < b.count {
                guard b[i] == 0xFF else { return nil }
                let marker = b[i + 1]
                if marker == 0xFF { i += 1; continue }
                if marker == 0xD8 || marker == 0x01 || (0xD0...0xD7).contains(marker) { i += 2; continue }
                let length = be16(i + 2)
                if (0xC0...0xCF).contains(marker), marker != 0xC4, marker != 0xC8, marker != 0xCC {
                    return PixelSize(width: be16(i + 7), height: be16(i + 5))
                }
                i += 2 + length
            }
            return nil
        }
        // WebP: RIFF....WEBP, then a VP8X, VP8L or VP8 chunk.
        if b.count >= 30, b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46, b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 {
            let chunk = String(bytes: b[12..<16], encoding: .ascii)
            switch chunk {
            case "VP8X": return PixelSize(width: le24(24) + 1, height: le24(27) + 1)
            case "VP8L":
                let bits = Int(b[21]) | Int(b[22]) << 8 | Int(b[23]) << 16 | Int(b[24]) << 24
                return PixelSize(width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1)
            case "VP8 ": return PixelSize(width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF)
            default: return nil
            }
        }
        return nil
    }
}

/// `chat:generateImage` argument (`ImageTurnOptions`): only `PHONE_IMAGE_TURN_KEYS`.
/// With photos, the edit's size is the first photo's shape at the chat's pixel count.
public func imageTurnOptions(sessionId: String, prompt: String, params: ImageParams, images: [String] = []) -> JSONValue? {
    guard let p = params.json else { return nil }
    var o: [String: JSONValue] = ["sessionId": .string(sessionId), "prompt": .string(prompt), "params": p]
    let photos = Array(images.prefix(PhotoEdit.maxPhotos))
    if !photos.isEmpty {
        o["images"] = .array(photos.map { .string($0) })
        let size: (width: Int64, height: Int64) = PhotoEdit.size(of: photos[0]).map { PhotoEdit.editSize(photo: $0, chosen: params) }
            ?? (params.width, params.height)
        o["size"] = ["width": .int(size.width), "height": .int(size.height)]
    }
    return .object(o)
}
