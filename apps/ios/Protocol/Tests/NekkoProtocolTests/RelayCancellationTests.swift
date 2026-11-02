import Foundation
import Testing
@testable import NekkoProtocol

/// Relay requests honor task cancellation (#1412): cancelling the caller ends
/// the wait at once instead of at the reply or the request's timeout.
struct RelayCancellationTests {
    let key = E2E.randomBytes(32)

    func client(_ relay: RelayClientTests.FakeRelay) -> RelayClient {
        var cfg = RelayConfig(relayUrl: "wss://relay.test/", room: "abcd1234", key: "k&e+y", keyBytes: key, deviceId: "dev-1",
                              deviceName: "iPhone", pairCode: nil)
        cfg.handshakeTimeout = 2
        cfg.requestTimeout = 60
        cfg.retryBase = 0.02
        cfg.retryMax = 0.08
        cfg.offlinePoll = 0.04
        return RelayClient(config: cfg, transport: relay)
    }

    @Test("Cancelling a call the computer never answers ends it at once")
    func cancelledCallEndsAtOnce() async throws {
        let relay = RelayClientTests.FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil }
        let c = client(relay)
        c.connect()
        let call = Task { try await c.call(Channels.appInfo, [], timeout: 60) }
        // Once the request is out, the only thing left is the wait.
        for _ in 0..<500 where relay.sync({ relay.requests.isEmpty }) { try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(!relay.sync { relay.requests.isEmpty })
        let start = Date()
        call.cancel()
        await #expect(throws: CancellationError.self) { try await call.value }
        #expect(Date().timeIntervalSince(start) < 5, "not the 60 s timeout")
        c.close()
    }

    @Test("A call made from a cancelled task throws without waiting")
    func callFromACancelledTask() async throws {
        let relay = RelayClientTests.FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil }
        let c = client(relay)
        c.connect()
        let call = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await c.call(Channels.appInfo, [], timeout: 60)
        }
        let start = Date()
        await #expect(throws: CancellationError.self) { try await call.value }
        #expect(Date().timeIntervalSince(start) < 5)
        c.close()
    }
}
