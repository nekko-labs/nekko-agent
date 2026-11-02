import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer that takes a moment to register a key, so two changes started
/// together are both waiting on it.
final class SlowKeyComputer: ProofCaller, @unchecked Sendable {
    let inner = ProofComputer()

    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        if channel == ChangeProof.keyChannel { try await Task.sleep(nanoseconds: 50_000_000) }
        return try await inner.call(channel, args, proof: proof, timeout: timeout)
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: nil, timeout: timeout)
    }
}

struct ChangeKeyRegistrationTests {
    @Test("Changes started together share one key registration")
    func concurrentChangesRegisterOnce() async throws {
        let computer = SlowKeyComputer()
        let now = computer.inner.now
        let calls = ChangeCalls(caller: computer, signer: SoftwareChangeSigner(), deviceId: "phone-1", computerName: "Studio",
                                now: { now })
        async let a = calls.call(change: "file:write", ["s1", ["path": "a.txt", "text": "a"]])
        async let b = calls.call(change: "file:write", ["s1", ["path": "b.txt", "text": "b"]])
        let (first, second) = try await (a, b)
        #expect(first == ["ok": "file:write"])
        #expect(second == ["ok": "file:write"])
        #expect(computer.inner.channels().filter { $0 == ChangeProof.keyChannel }.count == 1)
    }

    @Test("A failed registration is tried again by the next change")
    func failedRegistrationRetries() async throws {
        let computer = SlowKeyComputer()
        let now = computer.inner.now
        let calls = ChangeCalls(caller: computer, signer: SoftwareChangeSigner(), deviceId: "phone-1", computerName: "Studio",
                                now: { now })
        computer.inner.key = Data([1, 2, 3])
        await #expect(throws: (any Error).self) { try await calls.call(change: "file:write", ["s1", ["path": "a.txt", "text": "a"]]) }
        computer.inner.key = nil
        let out = try await calls.call(change: "file:write", ["s1", ["path": "a.txt", "text": "a"]])
        #expect(out == ["ok": "file:write"])
    }
}
