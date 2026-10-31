import Foundation
import NekkoProtocol

/// A connection that can carry a signed Change proof beside a call's args.
public protocol ProofCaller: Caller {
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue
    /// With a step-up beside the proof (SK-6): `StepUpProof.json`.
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, stepUp: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue
}

extension ProofCaller {
    /// A connection that can't carry a step-up never drops one silently.
    public func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, stepUp: JSONValue?,
                     timeout: TimeInterval?) async throws -> JSONValue {
        if case .some = stepUp { throw RelayError("This connection can’t carry a security key confirmation.") }
        return try await call(channel, args, proof: proof, timeout: timeout)
    }
}

extension RelayClient: ProofCaller {}

/// A Change action the computer refused, said plainly.
public struct ChangeRefused: Error, Equatable, LocalizedError, Sendable {
    /// The computer's code (`change-off`, `proof-stale`, ...), or nil when it wasn't a refusal.
    public let code: String?
    public let message: String
    public var errorDescription: String? { message }
    public init(code: String?, message: String) {
        self.code = code
        self.message = message
    }
}

/// Change actions from this phone (TASKS.md IO-33): every call is signed
/// (`ChangeProof`), and the phone's key is registered with the computer on
/// the first one (trust on first use). Feature screens call
/// `ComputersStore.call(change:_:)`, which uses this.
///
/// An actor: its state (registered, the last timestamp, the registration in
/// flight) changes only in its synchronous parts, and concurrent calls share
/// one key registration instead of each sending their own.
public actor ChangeCalls {
    private let caller: ProofCaller
    private let signer: ChangeSigner
    private let deviceId: String
    private let computerName: String
    private let now: @Sendable () -> Int64
    private var registered = false
    /// The key registration in flight: every call that needs it awaits this one.
    private var registering: Task<Void, Error>?
    private var lastTs: Int64 = 0

    public init(caller: ProofCaller, signer: ChangeSigner, deviceId: String, computerName: String,
                now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.caller = caller
        self.signer = signer
        self.deviceId = deviceId
        self.computerName = computerName
        self.now = now
    }

    /// Call a change-class channel with a fresh proof. Registers this phone's
    /// key first if this connection hasn't yet. A refusal comes back as a
    /// `ChangeRefused` with a message for the owner. `stepUp` (SK-6) rides
    /// beside the proof when the computer asked for one.
    public func call(change channel: String, _ args: [JSONValue] = [], stepUp: JSONValue? = nil,
                     timeout: TimeInterval? = nil) async throws -> JSONValue {
        do {
            try await registerIfNeeded()
            return try await signed(channel, args, stepUp: stepUp, timeout: timeout)
        } catch let e as RelayError where e.fromComputer {
            guard let refusal = PhoneRefusal(e.message) else { throw e }
            if refusal.code == "key-missing" {
                // The computer lost the key (paired again on its side): register and try once more.
                registered = false
                do {
                    try await registerIfNeeded()
                    return try await signed(channel, args, stepUp: stepUp, timeout: timeout)
                } catch let again as RelayError where again.fromComputer {
                    throw refused(again.message)
                }
            }
            throw ChangeRefused(code: refusal.code, message: refusal.message(computer: computerName) ?? e.message)
        } catch is ChangeProof.Unsignable {
            throw ChangeRefused(code: nil, message: "This change can’t be sent from a phone.")
        }
    }

    private func refused(_ message: String) -> ChangeRefused {
        let r = PhoneRefusal(message)
        return ChangeRefused(code: r?.code, message: r?.message(computer: computerName) ?? message)
    }

    /// Registers this phone's key unless it is. Concurrent callers (stage and
    /// commit tapped quickly, or a key-missing retry beside another call) all
    /// await the one registration in flight; a failed one is tried again by the
    /// next call.
    private func registerIfNeeded() async throws {
        if registered { return }
        if let registering { return try await registering.value }
        let task = Task {
            let key: JSONValue = .string(try signer.publicKey().base64EncodedString())
            _ = try await signed(ChangeProof.keyChannel, [key], stepUp: nil, timeout: nil)
        }
        registering = task
        defer { registering = nil }
        try await task.value
        registered = true
    }

    /// Never the same timestamp twice: the computer refuses a proof it has
    /// seen, and the same call signed twice in one millisecond would be one.
    private func nextTs() -> Int64 {
        lastTs = max(now(), lastTs + 1)
        return lastTs
    }

    private func signed(_ channel: String, _ args: [JSONValue], stepUp: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        let proof = try await ChangeProof.proof(signer: signer, deviceId: deviceId, channel: channel, args: args, ts: nextTs())
        guard let stepUp else { return try await caller.call(channel, args, proof: proof, timeout: timeout) }
        return try await caller.call(channel, args, proof: proof, stepUp: stepUp, timeout: timeout)
    }
}
