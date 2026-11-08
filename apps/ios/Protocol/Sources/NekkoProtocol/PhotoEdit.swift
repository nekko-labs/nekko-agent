import Foundation

// Photo editing in image chats (decision 0067: an attached photo means edit;
// decision 0069: the phone sends it as `images` and `size` inside the signed
// `chat:generateImage` request). A port of the desktop's photoEdit.ts.

public struct PixelSize: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// How a reply's picture was made (`GeneratedImageMeta`), as far as the phone
/// needs it. A clip (`video` set) is an animation from a video model: it is
/// not offered for editing, as on the desktop.
public struct GeneratedPicture: Equatable, Sendable {
    public let modelId: String?
    public let width: Int64?
    public let height: Int64?
    public let isClip: Bool

    public init(modelId: String? = nil, width: Int64? = nil, height: Int64? = nil, isClip: Bool = false) {
        self.modelId = modelId
        self.width = width
        self.height = height
        self.isClip = isClip
    }

    public static func from(_ v: JSONValue?) -> GeneratedPicture? {
        guard let v, v.object != nil else { return nil }
        return GeneratedPicture(modelId: v.str("modelId"), width: v.long("width"), height: v.long("height"),
                                isClip: v["video"].map { !$0.isNull } ?? false)
    }
}

/// The desktop's photoEdit.ts: what an image chat sends to edit.
public enum PhotoEdit {
    /// At most this many photos to edit from (the engine and the phone gate refuse more).
    public static let maxPhotos = 4
    /// A photo's longest side once attached.
    public static let maxEdge = 1536
    /// The photo types the phone gate takes (`data:image/png|jpeg|webp;base64,`).
    public static let types = ["image/png", "image/jpeg", "image/webp"]

    /// JavaScript's `Math.round`, so sizes match the desktop's to the pixel (halves round up).
    static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    /// `fitWithin`: scaled so the longest side is at most `max`, never enlarged.
    public static func fit(_ size: PixelSize, max edge: Int = maxEdge) -> PixelSize {
        let longest = Swift.max(size.width, size.height)
        guard longest > 0 else { return size }
        let scale = Swift.min(1, Double(edge) / Double(longest))
        return PixelSize(width: Swift.max(1, jsRound(Double(size.width) * scale)),
                         height: Swift.max(1, jsRound(Double(size.height) * scale)))
    }

    private static func snap(_ n: Double) -> Int { Swift.min(2048, Swift.max(256, jsRound(n / 64) * 64)) }

    /// `editSize`: the photo's shape with about as many pixels as the chat's
    /// chosen size, in the multiples of 64 the engine accepts (256-2048).
    public static func editSize(photo: PixelSize, chosen: PixelSize) -> PixelSize {
        guard photo.width > 0, photo.height > 0 else { return chosen }
        let area = Double(chosen.width) * Double(chosen.height)
        let ratio = Double(photo.width) / Double(photo.height)
        return PixelSize(width: snap((area * ratio).squareRoot()), height: snap((area / ratio).squareRoot()))
    }

    /// All photos of one request together, in characters: the phone gate's cap (6 MiB).
    public static let maxTotalChars = 6_291_456

    /// Whether the computer's gate takes this as a photo to edit: a lowercase
    /// `data:image/png|jpeg|webp;base64,` prefix, then non-empty standard base64
    /// (A-Z a-z 0-9 + /, at most two trailing `=`, no whitespace).
    public static func accepts(_ dataURL: String) -> Bool {
        guard let type = types.first(where: { dataURL.hasPrefix("data:\($0);base64,") }) else { return false }
        let body = dataURL.utf8.dropFirst("data:\(type);base64,".utf8.count)
        let padding = body.reversed().prefix { $0 == UInt8(ascii: "=") }.count
        guard !body.isEmpty, padding <= 2, padding < body.count else { return false }
        return body.dropLast(padding).allSatisfy { c in
            (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2B || c == 0x2F
        }
    }

    /// Whether these photos together fit the phone gate's cap.
    public static func fitsTotal(_ images: [String]) -> Bool {
        images.reduce(0) { $0 + $1.utf8.count } <= maxTotalChars
    }

    /// A data URL's pixel size from its PNG, JPEG or WebP header; nil when it can't be read.
    public static func size(of dataURL: String) -> PixelSize? {
        guard dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]), options: .ignoreUnknownCharacters)
        else { return nil }
        return size(of: [UInt8](data))
    }

    static func size(of b: [UInt8]) -> PixelSize? {
        func be16(_ i: Int) -> Int { Int(b[i]) << 8 | Int(b[i + 1]) }
        func be32(_ i: Int) -> Int { be16(i) << 16 | be16(i + 2) }
        func le16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
        func le24(_ i: Int) -> Int { le16(i) | Int(b[i + 2]) << 16 }
        let found: PixelSize?
        // PNG: the IHDR chunk right after the signature.
        if b.count >= 24, b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 {
            found = PixelSize(width: be32(16), height: be32(20))
        } else if b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 {
            // JPEG: the first start-of-frame marker.
            var i = 2
            var sof: PixelSize?
            while sof == nil, i + 9 < b.count {
                guard b[i] == 0xFF else { break }
                let marker = b[i + 1]
                if marker == 0xFF { i += 1; continue }
                if marker == 0xD8 || marker == 0x01 || (0xD0...0xD7).contains(marker) { i += 2; continue }
                if (0xC0...0xCF).contains(marker), marker != 0xC4, marker != 0xC8, marker != 0xCC {
                    sof = PixelSize(width: be16(i + 7), height: be16(i + 5))
                } else {
                    i += 2 + be16(i + 2)
                }
            }
            found = sof
        } else if b.count >= 30, b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46,
                  b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 {
            // WebP: RIFF....WEBP, then a VP8X, VP8L or VP8 chunk.
            switch String(bytes: b[12..<16], encoding: .ascii) {
            case "VP8X": found = PixelSize(width: le24(24) + 1, height: le24(27) + 1)
            case "VP8L":
                let bits = Int(b[21]) | Int(b[22]) << 8 | Int(b[23]) << 16 | Int(b[24]) << 24
                found = PixelSize(width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1)
            case "VP8 ": found = PixelSize(width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF)
            default: found = nil
            }
        } else {
            found = nil
        }
        guard let found, found.width > 0, found.height > 0 else { return nil }
        return found
    }
}
