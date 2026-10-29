import Foundation
import NekkoProtocol

/// The preview window's and the preview cards' reads (#1095): files through
/// `artifact:read`, loopback pages through `preview:fetch`. What came back is
/// kept in memory per chat and path (or URL), so a card's thumbnail and the
/// window it opens read the computer once; Reload asks again. Thumbnails take
/// one of a few slots, so a long chat doesn't fetch every page at once.
@MainActor
public final class PreviewLoader {
    public typealias Call = @MainActor @Sendable (PreviewRequest) async throws -> JSONValue
    /// A body the web view can be handed: bytes and their type.
    public struct Body: Equatable, Sendable {
        public let data: Data
        public let mime: String
        public let charset: String?
        public let status: Int
        /// Only the start of a large text file came (the computer cuts text at 1 MiB).
        public let truncated: Bool
        /// The whole file's size, when it was cut.
        public let size: Int64
        public init(data: Data, mime: String, charset: String? = nil, status: Int = 200, truncated: Bool = false, size: Int64? = nil) {
            self.data = data
            self.mime = mime
            self.charset = charset
            self.status = status
            self.truncated = truncated
            self.size = size ?? Int64(data.count)
        }
    }

    private let read: Call
    private var cache: [String: Body] = [:]
    private var order: [String] = []
    private var bytes = 0
    /// What the cache may hold in total.
    public let byteLimit: Int
    private var inFlight: [String: Task<Body, Error>] = [:]
    private var slotsFree: Int
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init(read: @escaping Call, byteLimit: Int = 32 * 1024 * 1024, thumbnailSlots: Int = 2) {
        self.read = read
        self.byteLimit = byteLimit
        slotsFree = thumbnailSlots
    }

    public convenience init(store: ComputersStore) {
        self.init(read: { [weak store] r in
            guard let store else { throw RelayError("Not connected to a computer.") }
            return try await store.call(read: r.channel, r.args)
        })
    }

    /// The file at `path`, as `artifact:read` sent it.
    public func artifact(_ sessionId: String, _ path: String, reload: Bool = false) async throws -> Body {
        try await load("a|\(sessionId)|\(path)", reload: reload) { [read] in
            let v = try await read(.artifact(sessionId, path))
            guard let f = ArtifactFile.from(v) else { throw RelayError("Your computer sent nothing to show.") }
            // A large binary file comes without its bytes; a large text file comes cut.
            if f.truncated && (f.data.isEmpty || !f.isText) { throw RelayError("Too large to open on a phone (\(Self.megabytes(f.size))).") }
            let ct = PreviewSchemes.splitContentType(f.mime)
            return Body(data: f.data, mime: ct.mime, charset: f.isText ? (ct.charset ?? "utf-8") : ct.charset,
                        truncated: f.truncated, size: f.size)
        }
    }

    /// The loopback page or asset at `url`, fetched by the computer.
    public func fetch(_ sessionId: String, _ url: URL, reload: Bool = false) async throws -> Body {
        try await load("l|\(sessionId)|\(url.absoluteString)", reload: reload) { [read] in
            let v = try await read(.fetch(sessionId, url))
            guard let r = PreviewResponse.from(v) else { throw RelayError("Your computer sent nothing to show.") }
            if r.redirectedAway { throw RelayError("The preview server sent this page somewhere else.") }
            if r.truncated { throw RelayError("Too large to open on a phone.") }
            let ct = PreviewSchemes.splitContentType(r.contentType.isEmpty ? PreviewSchemes.mime(forPath: url.path) : r.contentType)
            return Body(data: r.body, mime: ct.mime, charset: ct.charset, status: r.status)
        }
    }

    /// What was read before, without asking the computer.
    public func cached(artifact sessionId: String, _ path: String) -> Body? { cache["a|\(sessionId)|\(path)"] }
    public func cached(fetch sessionId: String, _ url: URL) -> Body? { cache["l|\(sessionId)|\(url.absoluteString)"] }

    /// Forget a chat's reads (Reload in the window).
    public func forget(_ sessionId: String) {
        for key in Array(cache.keys) where key.split(separator: "|", maxSplits: 2).dropFirst().first == Substring(sessionId) {
            drop(key)
        }
    }

    /// Run `work` while holding a thumbnail slot; waits for one to free up.
    public func withThumbnailSlot<T>(_ work: () async throws -> T) async rethrows -> T {
        if slotsFree > 0 {
            slotsFree -= 1
        } else {
            await withCheckedContinuation { waiting.append($0) }
        }
        defer {
            if waiting.isEmpty { slotsFree += 1 } else { waiting.removeFirst().resume() }
        }
        return try await work()
    }

    /// The message for a failed read.
    public static func message(_ error: Error, loopback: Bool) -> String {
        if let r = error as? ChangeRefused { return r.message }
        return PreviewError.plain(error.localizedDescription, loopback: loopback)
    }

    private func load(_ key: String, reload: Bool, _ fetch: @escaping @MainActor @Sendable () async throws -> Body) async throws -> Body {
        if reload { drop(key) } else if let hit = cache[key] {
            touch(key)
            return hit
        }
        if let running = inFlight[key] { return try await running.value }
        let task = Task { @MainActor in try await fetch() }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        let body = try await task.value
        store(key, body)
        return body
    }

    /// `12.5 MB`, without ByteCountFormatter (not on every platform the package builds for).
    nonisolated static func megabytes(_ n: Int64) -> String {
        let mb = Double(n) / 1_000_000
        return mb >= 10 ? "\(Int(mb.rounded())) MB" : String(format: "%.1f MB", mb)
    }

    private func store(_ key: String, _ body: Body) {
        guard body.data.count <= byteLimit else { return }
        drop(key)
        cache[key] = body
        order.append(key)
        bytes += body.data.count
        while bytes > byteLimit, let oldest = order.first { drop(oldest) }
    }

    private func touch(_ key: String) {
        if let i = order.firstIndex(of: key) { order.remove(at: i); order.append(key) }
    }

    private func drop(_ key: String) {
        guard let old = cache.removeValue(forKey: key) else { return }
        bytes -= old.data.count
        if let i = order.firstIndex(of: key) { order.remove(at: i) }
    }
}
