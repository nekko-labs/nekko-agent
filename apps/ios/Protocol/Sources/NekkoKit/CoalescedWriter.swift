import Foundation

/// One background queue that runs small file writes in the order they were
/// asked for, so a removal never overtakes the write before it.
public final class BackgroundIO: @unchecked Sendable {
    private let queue: DispatchQueue

    public init(label: String = "nekko.background-io") {
        queue = DispatchQueue(label: label, qos: .utility)
    }

    public func run(_ work: @escaping @Sendable () -> Void) { queue.async(execute: work) }

    /// Returns when everything asked for before this call has run (blocks the caller:
    /// for a read that must see the writes before it).
    public func waitUntilIdle() { queue.sync {} }

    /// The same, for async callers. It then hops to the main actor, behind any
    /// main-actor follow-up (`Task { @MainActor in ... }`) the finished work started.
    @MainActor
    public func idle() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async { c.resume() }
        }
        await Task { @MainActor in }.value
    }
}

/// Saves that arrive in a burst become one write of the newest value. The main
/// thread only files the value away (`submit`); the work itself (encoding,
/// hashing, writing) runs on a background queue after `delay`, newest value per
/// key. Used for the saved chat lists and the saved transcripts (#3386).
@MainActor
public final class CoalescedWriter<Value: Sendable> {
    private let delay: TimeInterval
    private let io: BackgroundIO
    private let write: @Sendable (String, Value) -> Void
    private var pendingValues: [String: Value] = [:]
    private var timer: Task<Void, Never>?
    /// Writes handed to the queue since the writer was made.
    public private(set) var dispatched = 0

    public init(delay: TimeInterval = 0.25, io: BackgroundIO, write: @escaping @Sendable (String, Value) -> Void) {
        self.delay = delay
        self.io = io
        self.write = write
    }

    /// The value waiting to be written for `key`, if any: what a read must prefer to the file.
    public func pending(_ key: String) -> Value? { pendingValues[key] }

    public var hasPending: Bool { !pendingValues.isEmpty }

    /// Replace whatever waits for `key` with `value`; it is written after `delay` (the
    /// first submit of a burst sets the time, so a long burst still writes steadily).
    public func submit(_ key: String, _ value: Value) {
        pendingValues[key] = value
        guard timer == nil else { return }
        let nanos = UInt64(max(0, delay) * 1_000_000_000)
        timer = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            self?.flushNow()
        }
    }

    /// Hand everything waiting to the queue now (the app is going to the background).
    public func flushNow() {
        timer?.cancel()
        timer = nil
        let batch = pendingValues
        pendingValues = [:]
        for (key, value) in batch {
            dispatched += 1
            let write = write
            io.run { write(key, value) }
        }
    }

    /// Hand everything waiting to the queue and wait for the queue to finish.
    public func flush() async {
        flushNow()
        await io.idle()
    }

    /// Forget what waits for `key` (the thing it would write is gone).
    public func cancel(_ key: String) { pendingValues[key] = nil }

    public func cancelAll() {
        pendingValues = [:]
        timer?.cancel()
        timer = nil
    }
}
