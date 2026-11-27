import Foundation

/// A computer of your own Nekko Cloud account, opened with no pairing (decisions 0102 and 0128;
/// `crates/nekko-sync/src/fleet_link.rs`, Android's `FleetLink.kt`). The HELLO carries a proof
/// sealed under the *account* keyring in the record envelope, with its own associated data, that
/// binds the one handshake it answers. Only sealing and checking live here; nothing is stored.
public enum FleetLink {
    /// What a fleet HELLO proof binds: this one handshake, as both ends hold it.
    public struct Binding: Equatable, Sendable {
        public let room: String
        public let challenge: String
        public let hostEph: String
        public let clientEph: String
        public let helloKey: String

        public init(room: String, challenge: String, hostEph: String, clientEph: String, helloKey: String) {
            self.room = room
            self.challenge = challenge
            self.hostEph = hostEph
            self.clientEph = clientEph
            self.helloKey = helloKey
        }
    }

    /// The HELLO `deviceId` of an account device, apart from every pairing's id.
    public static func linkDeviceId(_ accountDeviceId: String) -> String { "fleet:\(accountDeviceId)" }

    /// The sentence for a refusal the computer sent in `denied` (nil for any other reason).
    public static func refusalText(_ reason: DenyReason, computer name: String) -> String? {
        switch reason {
        case .fleetOff: return "\(name) doesn’t let devices on your Nekko Cloud account connect without pairing."
        case .fleetLocked: return "\(name) is signed out of Nekko Cloud or locked."
        case .fleetEpoch: return "\(name) doesn’t have your newest sync key yet."
        case .fleetDevice: return "\(name) doesn’t know this iPhone yet."
        case .fleetAccount: return "\(name) belongs to a different Nekko Cloud account."
        default: return nil
        }
    }

    /// Whether one more try can help: the computer reads the account again after these two.
    public static func retryable(_ reason: DenyReason) -> Bool { reason == .fleetDevice || reason == .fleetEpoch }

    /// The associated data of a HELLO proof. A server-issued id may not carry a separator or a newline into it.
    public static func helloAAD(accountId: String, keyId: UInt32, deviceId: String) throws -> String {
        guard keyId > 0, valid(accountId), valid(deviceId) else { throw SyncCrypto.Failure.invalid }
        return "\(SyncCrypto.version) fleet-hello\n\(accountId)\n\(keyId)\n\(deviceId)"
    }

    private static func valid(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 64 && id.utf8.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f
        }
    }

    public static func sealHelloProof(keyring: SyncCrypto.Keyring, accountId: String, keyId: UInt32, deviceId: String,
                                      plaintext: Data, salt: Data? = nil) throws -> String {
        try SyncCrypto.sealWithAAD(keyring: keyring, aad: helloAAD(accountId: accountId, keyId: keyId, deviceId: deviceId),
                                   plaintext: plaintext, salt: salt)
    }

    public static func openHelloProof(keyring: SyncCrypto.Keyring, accountId: String, keyId: UInt32, deviceId: String,
                                      blob: String) throws -> Data {
        try SyncCrypto.openWithAAD(keyring: keyring, aad: helloAAD(accountId: accountId, keyId: keyId, deviceId: deviceId), blob: blob)
    }

    /// The proof's plaintext: the same binding the HELLO signs, with an empty `orgId` for an account device.
    public static func proofPlaintext(_ b: Binding, orgId: String = "") -> Data {
        Data(JSONValue.object(["v": .int(1), "orgId": .string(orgId), "room": .string(b.room), "challenge": .string(b.challenge),
                               "hostEph": .string(b.hostEph), "clientEph": .string(b.clientEph), "helloKey": .string(b.helloKey)])
            .serialized().utf8)
    }

    /// The HELLO's `fleet` object: who this device is and a proof, sealed under the account's *current* keyring.
    public static func hello(keyring: SyncCrypto.Keyring, accountId: String, keyId: UInt32, deviceId: String,
                             binding: Binding, orgId: String = "") -> JSONValue? {
        guard let proof = try? sealHelloProof(keyring: keyring, accountId: accountId, keyId: keyId, deviceId: deviceId,
                                              plaintext: proofPlaintext(binding, orgId: orgId)) else { return nil }
        return .object(["v": .int(1), "accountId": .string(accountId), "keyId": .int(Int64(keyId)), "deviceId": .string(deviceId),
                        "proof": .string(proof)])
    }
}

extension SyncCrypto.Keyring: @unchecked Sendable {}
