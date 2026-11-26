#if canImport(ImageIO) && canImport(CoreGraphics)
import CoreGraphics
import Foundation
import ImageIO

/// Small copies of the photos in a transcript (`data:image/...;base64,` URLs the
/// computer sends), decoded off the main thread with ImageIO thumbnailing and kept
/// in a bounded cache so scrolling a chat back over a photo prompt costs a lookup,
/// not a base64 decode. The Android app does the same (`PromptPhotos.kt`: LRU,
/// off the main thread).
public final class PhotoThumbnails: @unchecked Sendable {
    /// The app's shared cache: up to 200 thumbnails or 24 MB of pixels.
    public static let shared = PhotoThumbnails(countLimit: 200, byteLimit: 24 * 1024 * 1024)

    /// Longest side, in pixels, of a thumbnail.
    public static let maxPixelSize = 240

    private final class Box { let image: CGImage?; init(_ image: CGImage?) { self.image = image } }
    private let cache = NSCache<NSString, Box>()

    public init(countLimit: Int, byteLimit: Int) {
        cache.countLimit = countLimit
        cache.totalCostLimit = byteLimit
    }

    /// A cheap identity for a photo URL: its length plus its head and tail. A
    /// transcript photo is hundreds of kilobytes, so hashing all of it on the main
    /// thread would cost what the cache saves.
    static func key(_ url: String) -> NSString {
        var hasher = Hasher()
        hasher.combine(url.utf8.count)
        hasher.combine(String(url.prefix(96)))
        hasher.combine(String(url.suffix(96)))
        return String(hasher.finalize()) as NSString
    }

    /// The cached thumbnail, without decoding. `.some(nil)` means the photo was
    /// tried and is unreadable (or withheld), so there is nothing to show.
    public func cached(_ url: String) -> CGImage?? {
        guard let box = cache.object(forKey: Self.key(url)) else { return nil }
        return .some(box.image)
    }

    /// The thumbnail for `url`, decoded on a background task the first time.
    public func load(_ url: String) async -> CGImage? {
        let key = Self.key(url)
        if let box = cache.object(forKey: key) { return box.image }
        let image = await Task.detached(priority: .userInitiated) { Self.decode(url) }.value
        let cost = image.map { $0.bytesPerRow * $0.height } ?? 1
        cache.setObject(Box(image), forKey: key, cost: cost)
        return image
    }

    public func removeAll() { cache.removeAllObjects() }

    /// Decode only a small preview. ImageIO honours EXIF orientation without
    /// rasterising the whole attachment. nil for anything that is not an image data URL.
    public static func decode(_ url: String) -> CGImage? {
        guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary)
    }
}
#endif
