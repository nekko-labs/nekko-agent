import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NekkoProtocol

/// The computer's side of the relay handshake, for every test that plays it
/// (`challenge` and `on_hello` in crates/nekko-remote/src/agent.rs).
struct TestComputer {
    let room: String
    let roomKey: Data
    var hostKey = P256.Signing.PrivateKey()

    /// A challenge sent, and the computer's half of its exchange.
    struct Issued {
        let nonce: String
        let eph: Ephemeral
    }

    /// The key a device pins: X9.63, base64.
    var publicKey: String { hostKey.publicKey.x963Representation.base64EncodedString() }

    /// A fresh challenge, signed with the host key unless `signer` says otherwise.
    func issue(signer: P256.Signing.PrivateKey? = nil) -> (issued: Issued, frame: JSONValue) {
        let issued = Issued(nonce: E2E.randomBytes(18).base64EncodedString(), eph: Ephemeral())
        let text = HostKey.text(room: room, challenge: issued.nonce, eph: issued.eph.publicKey)
        let sig = try! (signer ?? hostKey).signature(for: Data(text.utf8)).rawRepresentation
        return (issued, ["type": "challenge", "challenge": .string(issued.nonce), "eph": .string(issued.eph.publicKey),
                         "sig": .string(sig.base64EncodedString())])
    }

    /// A device's `{eph, enc}`: the HELLO and the session key, or nil if it isn't this exchange's.
    func open(_ answer: JSONValue, to issued: Issued) -> (hello: JSONValue, session: Data)? {
        guard let theirs = answer.str("eph"), let enc = answer.str("enc") else { return nil }
        let info = HostKey.sessionInfo(room: room, challenge: issued.nonce, hostEph: issued.eph.publicKey, clientEph: theirs)
        guard let session = issued.eph.sessionKey(theirs: theirs, info: info),
              let hello = try? E2E.open(key: session, blob: enc) else { return nil }
        return (hello, session)
    }
}
