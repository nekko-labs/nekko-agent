import AuthenticationServices
import Foundation
import NekkoKit
import NekkoProtocol
import UIKit

/// The iPhone's FIDO2 client for step-up (SK-6): a security key over NFC,
/// Lightning or USB-C (`ASAuthorizationSecurityKeyPublicKeyCredentialProvider`)
/// or a passkey on this iPhone (`ASAuthorizationPlatformPublicKeyCredentialProvider`),
/// asked for an assertion over the computer's challenge, or registered with
/// the computer when it offers that. The computer is the relying party and
/// verifies everything (decision 0018); this only talks to the authenticator.
///
/// The relying-party id is the computer's own, `nekko-computer:<installId>`
/// (spec, Registering a method), not a web domain. Be clear about what that
/// means on iOS, because nobody has run this against a real key yet:
///
/// - **Passkeys on this iPhone**: Apple's platform provider only creates or
///   uses a passkey for a relying-party id that is one of the app's
///   associated domains (`webcredentials:` in the entitlements, confirmed by
///   that domain's apple-app-site-association file). A per-computer id is not
///   a domain anyone can host that file on, so we expect iOS to refuse
///   (`ASAuthorizationError.failed`, "not associated with domain"). Decision
///   0018 does not settle this; it says the phones "use the Apple and Google
///   app-attestation paths", which holds for Android's Credential Manager
///   (apk-key-hash origins) but has no iOS equivalent for a non-domain id.
/// - **Security keys**: the security-key provider is documented without the
///   associated-domain requirement in some places and with it in others; we
///   have not been able to check which applies to iOS 17/18 with a key in hand.
///   If iOS refuses here too, a key cannot answer on the iPhone either.
/// - The `clientDataJSON.origin` iOS writes is not documented for a
///   non-domain id. The computer accepts only the origins it recorded at
///   registration (`security.json` `origins`), so the first registration from
///   an iPhone (when the computer offers one) is what teaches it.
///
/// The fallback, in every one of these cases, is the one-time code: the
/// sheet always offers *Use a code* when the computer has TOTP, and a refusal
/// from iOS is shown in plain words with that way out, never as a dead end.
/// A browser-style client (`ASAuthorizationPublicKeyCredentialAssertionRequest`
/// with `clientData`, iOS 17.4) would let the app name its own origin, but it
/// needs Apple's web-browser credential entitlement, which this app does not
/// qualify for. Real-hardware checks are SK-12.
///
/// Not actor-isolated as a type, so a view can hold one in `@State`; every
/// ceremony runs on the main actor.
final class SecurityKeys: NSObject {
    enum Kind: Sendable {
        /// A FIDO2 key over NFC, Lightning or USB-C.
        case securityKey
        /// A passkey in this iPhone's Keychain (Face ID / Touch ID).
        case passkey

        var methodKind: StepUpMethodKind { self == .securityKey ? .securityKey : .passkey }
    }

    enum Failure: Error, Equatable {
        /// The owner closed the system sheet: nothing to say.
        case cancelled
        /// iOS couldn't ask the authenticator; `message` says so plainly.
        case unavailable(String)
        /// The authenticator answered with something the computer can't use.
        case unusable(String)
    }

    private var pending: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    // MARK: Assertion (answering a step-up)

    /// An assertion over `challenge` for `rpId`. The phone never learns the
    /// computer's credential ids (spec, Security boundaries), so the key or
    /// passkey must hold a discoverable credential for this computer;
    /// a key registered as non-discoverable on the desktop can't be found here.
    @MainActor
    func assert(kind: Kind, rpId: String, challenge: Data, computer: String) async throws -> StepUpAssertion {
        let request: ASAuthorizationRequest
        switch kind {
        case .securityKey:
            let r = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
                .createCredentialAssertionRequest(challenge: challenge)
            r.userVerificationPreference = .preferred
            request = r
        case .passkey:
            let r = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
                .createCredentialAssertionRequest(challenge: challenge)
            r.userVerificationPreference = .preferred
            request = r
        }
        let auth = try await perform(request, kind: kind, computer: computer)
        guard let a = auth.credential as? ASAuthorizationPublicKeyCredentialAssertion,
              let authData = a.rawAuthenticatorData, let sig = a.signature else {
            throw Failure.unusable("The \(kind == .securityKey ? "key" : "passkey") didn’t answer in a way \(computer) can check.")
        }
        return StepUpAssertion(credentialId: a.credentialID, authenticatorData: authData, clientDataJSON: a.rawClientDataJSON,
                               signature: sig)
    }

    // MARK: Registration (when the computer offers it)

    /// A new ES256 credential for the computer's relying party, read out of
    /// the attestation as the computer stores it.
    @MainActor
    func register(kind: Kind, offer: StepUpRegistrationOffer, name: String, computer: String) async throws -> StepUpRegistration {
        guard let challenge = StepUp.fromB64url(offer.challenge), let user = StepUp.fromB64url(offer.userId) else {
            throw Failure.unusable("\(computer) sent a registration this iPhone can’t read. Update Nekko Agent on it.")
        }
        let request: ASAuthorizationRequest
        switch kind {
        case .securityKey:
            let r = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: offer.rpId)
                .createCredentialRegistrationRequest(challenge: challenge, displayName: offer.userName, name: offer.userName, userID: user)
            r.credentialParameters = [ASAuthorizationPublicKeyCredentialParameters(algorithm: .ES256)]
            // Discoverable, so this iPhone can find it later without the computer naming it.
            r.residentKeyPreference = .required
            r.userVerificationPreference = .preferred
            r.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKind.none
            request = r
        case .passkey:
            let r = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: offer.rpId)
                .createCredentialRegistrationRequest(challenge: challenge, name: offer.userName, userID: user)
            r.userVerificationPreference = .preferred
            request = r
        }
        let auth = try await perform(request, kind: kind, computer: computer)
        guard let c = auth.credential as? ASAuthorizationPublicKeyCredentialRegistration, let attestation = c.rawAttestationObject,
              let reg = StepUpRegistration.from(kind: kind.methodKind, name: name, credentialId: c.credentialID,
                                                clientDataJSON: c.rawClientDataJSON, attestationObject: attestation) else {
            throw Failure.unusable("That \(kind == .securityKey ? "key" : "passkey") made a credential \(computer) can’t use (it needs a P-256 key).")
        }
        return reg
    }

    // MARK: The system sheet

    @MainActor
    private func perform(_ request: ASAuthorizationRequest, kind: Kind, computer: String) async throws -> ASAuthorization {
        // One ceremony at a time: a second ask cancels the first.
        pending?.resume(throwing: Failure.cancelled)
        pending = nil
        do {
            return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ASAuthorization, Error>) in
                pending = cont
                let c = ASAuthorizationController(authorizationRequests: [request])
                c.delegate = self
                c.presentationContextProvider = self
                controller = c
                c.performRequests()
            }
        } catch let e as Failure {
            throw e
        } catch let e as ASAuthorizationError {
            throw Self.failure(e, kind: kind, computer: computer)
        } catch {
            throw Failure.unavailable("This iPhone couldn’t ask your \(kind == .securityKey ? "security key" : "passkey"): \(error.localizedDescription)")
        }
    }

    /// iOS's refusal in the owner's words, with the way out.
    static func failure(_ e: ASAuthorizationError, kind: Kind, computer: String) -> Failure {
        let what = kind == .securityKey ? "a security key" : "a passkey on this iPhone"
        switch e.code {
        case .canceled:
            return .cancelled
        case .notInteractive:
            return .unavailable("Open Nekko Agent and try again to use \(what).")
        default:
            // Most likely the relying-party id (see the type's note): iOS won't use it for this computer.
            return .unavailable("This iPhone can’t use \(what) with \(computer) yet. Use a code instead.")
        }
    }

    @MainActor
    private func finish(_ result: Result<ASAuthorization, Error>) {
        let c = pending
        pending = nil
        controller = nil
        c?.resume(with: result)
    }
}

extension SecurityKeys: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated { finish(.success(authorization)) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated { finish(.failure(error)) }
    }
}

extension SecurityKeys: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            if let key = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return key }
            if let scene = scenes.first { return ASPresentationAnchor(windowScene: scene) }
            return ASPresentationAnchor()
        }
    }
}
