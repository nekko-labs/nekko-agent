import Foundation

/// Lets go of something expensive that sits idle: `release` runs once `after`
/// seconds pass with nothing using it. Each use calls `begin`/`end`; the clock
/// starts when the last use ends and is cancelled by the next `begin`. The
/// Mermaid renderer holds a web view this way (#3389), so a chat that drew one
/// diagram does not keep a WebKit process alive for the life of the app.
@MainActor
public final class IdleRelease {
    /// Waits out the idle time. Real use sleeps; tests pass a clock they move by hand,
    /// so a busy CI machine can never make the timer fire early or late.
    public typealias Sleep = @MainActor (_ nanoseconds: UInt64) async -> Void

    private let after: TimeInterval
    private let sleep: Sleep
    private let release: @MainActor () -> Void
    private var users = 0
    private var timer: Task<Void, Never>?
    /// How many times `release` has run (tests read it).
    public private(set) var releases = 0

    public init(
        after: TimeInterval,
        sleep: @escaping Sleep = { nanoseconds in _ = try? await Task.sleep(nanoseconds: nanoseconds) },
        release: @escaping @MainActor () -> Void
    ) {
        self.after = after
        self.sleep = sleep
        self.release = release
    }

    /// Something is using the resource: do not release it.
    public func begin() {
        users += 1
        timer?.cancel()
        timer = nil
    }

    /// That use is over; the idle clock starts when the last one is.
    public func end() {
        users = max(0, users - 1)
        guard users == 0 else { return }
        arm()
    }

    /// Start the clock without a use (the resource was just made and nothing has asked yet).
    public func arm() {
        timer?.cancel()
        let nanos = UInt64(max(0, after) * 1_000_000_000)
        timer = Task { @MainActor [weak self] in
            guard let wait = self?.sleep else { return }
            await wait(nanos)
            guard let self, !Task.isCancelled, self.users == 0 else { return }
            self.timer = nil
            self.releases += 1
            self.release()
        }
    }

    /// Release now if nothing is using it (a memory warning, the app going to the background).
    public func releaseIfIdle() {
        guard users == 0 else { return }
        timer?.cancel()
        timer = nil
        releases += 1
        release()
    }
}

/// Which files of an on-disk cache to delete so it stays within an age and a size.
public enum CachePruner {
    public struct File: Equatable, Sendable {
        public let name: String
        public let bytes: Int
        public let modified: Date
        public init(name: String, bytes: Int, modified: Date) {
            self.name = name
            self.bytes = bytes
            self.modified = modified
        }
    }

    /// Everything older than `maxAge`, then the oldest of the rest until the total is
    /// within `maxBytes`. A drawing's `.png` and `.svg` share a name before the dot and are
    /// kept or dropped together (`pairs`), so a half-cached drawing never stays behind.
    public static func plan(_ files: [File], maxBytes: Int, maxAge: TimeInterval, now: Date, pairs: Bool = true) -> [String] {
        func stem(_ n: String) -> String { pairs ? (n as NSString).deletingPathExtension : n }
        var groups: [String: (files: [File], bytes: Int, newest: Date)] = [:]
        for f in files {
            var g = groups[stem(f.name)] ?? ([], 0, .distantPast)
            g.files.append(f)
            g.bytes += f.bytes
            g.newest = max(g.newest, f.modified)
            groups[stem(f.name)] = g
        }
        var doomed: [String] = []
        var kept: [(files: [File], bytes: Int, newest: Date)] = []
        for g in groups.values {
            if now.timeIntervalSince(g.newest) > maxAge { doomed += g.files.map(\.name) } else { kept.append(g) }
        }
        var total = kept.reduce(0) { $0 + $1.bytes }
        for g in kept.sorted(by: { $0.newest < $1.newest }) where total > maxBytes {
            doomed += g.files.map(\.name)
            total -= g.bytes
        }
        return doomed.sorted()
    }
}
