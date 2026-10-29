package com.nekko.android.security

import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.domerrors.SecurityError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import com.nekko.protocol.StepUp
import com.nekko.protocol.StepUpMethod
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.StepUpRegistration
import kotlinx.coroutines.CancellationException

/**
 * Credential Manager (`androidx.credentials`) as the step-up's FIDO2 client:
 * `GetPublicKeyCredentialOption` reaches a security key over NFC or USB-C and
 * this phone's own passkeys; `CreatePublicKeyCredentialRequest` registers
 * either. [activity] must be an Activity context: the system sheet is shown
 * over it.
 *
 * What does not work yet, said plainly. Decision 0018 makes the computer the
 * relying party with the id `nekko-computer:<installId>` (spec: no domain, no
 * Nekko Cloud account). Android only lets an ordinary app use a relying-party
 * id that is a web domain whose `/.well-known/assetlinks.json` (Digital Asset
 * Links) names this app's package and signing certificate; only privileged
 * callers (browsers) may pass another origin, and that needs a permission this
 * app cannot hold. `nekko-computer:...` is not a domain, so Credential Manager
 * is expected to refuse it with a `SecurityError` ([KeyResult.Why.RP_REFUSED])
 * on every Android version. The second gap: the `clientDataJSON.origin` an app
 * gets is `android:apk-key-hash:<sha256 of the signing cert>`, which a computer
 * only accepts once it is in `security.json`'s `origins`, and nothing adds it
 * there yet (registration happens on the computer, from its own origin).
 *
 * Until the relying-party question is settled for Android (a decision, not
 * code), the step-up sheet falls back to the one-time code, the method the
 * decision record keeps for exactly this ("TOTP as the no-hardware fallback"),
 * and says why. The computer does send its id (`rpId` in the `security:challenge`
 * reply), so the phone always tries the key first; the refusal is caught and
 * worded, never shown raw. This client stays wired so the key path works the
 * day the computer's id is one Android accepts.
 * Not tried with a real key or a real phone: none was available.
 */
class CredentialManagerKeys(private val activity: Context) : KeyClient {
    private val manager by lazy { CredentialManager.create(activity) }

    override suspend fun assertion(challenge: String, rpId: String): KeyResult<StepUpProof.Assertion> {
        val option = GetPublicKeyCredentialOption(requestJson = StepUp.assertionRequestJson(challenge, rpId))
        return try {
            val result = manager.getCredential(activity, GetCredentialRequest(listOf(option)))
            val credential = result.credential as? PublicKeyCredential
                ?: return KeyResult.Failed(KeyResult.Why.UNREADABLE)
            StepUpProof.fromAuthenticationResponse(credential.authenticationResponseJson)
                ?.let { KeyResult.Ok(it) }
                ?: KeyResult.Failed(KeyResult.Why.UNREADABLE)
        } catch (e: CancellationException) {
            throw e
        } catch (_: GetCredentialCancellationException) {
            KeyResult.Cancelled
        } catch (e: NoCredentialException) {
            KeyResult.Failed(KeyResult.Why.NO_CREDENTIAL, e.errorMessage?.toString())
        } catch (e: GetPublicKeyCredentialDomException) {
            when (e.domError) {
                is SecurityError -> KeyResult.Failed(KeyResult.Why.RP_REFUSED, e.errorMessage?.toString())
                // WebAuthn's catch-all for "the user or the platform said no", including timeouts.
                is NotAllowedError -> KeyResult.Cancelled
                else -> KeyResult.Failed(KeyResult.Why.OTHER, e.errorMessage?.toString())
            }
        } catch (e: GetCredentialUnsupportedException) {
            KeyResult.Failed(KeyResult.Why.UNSUPPORTED, e.errorMessage?.toString())
        } catch (e: GetCredentialProviderConfigurationException) {
            KeyResult.Failed(KeyResult.Why.UNSUPPORTED, e.errorMessage?.toString())
        } catch (e: GetCredentialException) {
            KeyResult.Failed(KeyResult.Why.OTHER, e.errorMessage?.toString())
        }
    }

    override suspend fun register(
        challenge: String,
        rpId: String,
        rpName: String,
        userId: ByteArray,
        userName: String,
        kind: StepUpMethod,
    ): KeyResult<StepUpRegistration> {
        val request = CreatePublicKeyCredentialRequest(
            requestJson = StepUp.registrationRequestJson(challenge, rpId, rpName, userId, userName, kind),
        )
        return try {
            val response = manager.createCredential(activity, request) as? CreatePublicKeyCredentialResponse
                ?: return KeyResult.Failed(KeyResult.Why.UNREADABLE)
            StepUpRegistration.fromRegistrationResponse(response.registrationResponseJson, kind)
                ?.let { KeyResult.Ok(it) }
                ?: KeyResult.Failed(KeyResult.Why.UNREADABLE)
        } catch (e: CancellationException) {
            throw e
        } catch (_: CreateCredentialCancellationException) {
            KeyResult.Cancelled
        } catch (e: CreatePublicKeyCredentialDomException) {
            when (e.domError) {
                is SecurityError -> KeyResult.Failed(KeyResult.Why.RP_REFUSED, e.errorMessage?.toString())
                is NotAllowedError -> KeyResult.Cancelled
                else -> KeyResult.Failed(KeyResult.Why.OTHER, e.errorMessage?.toString())
            }
        } catch (e: CreateCredentialUnsupportedException) {
            KeyResult.Failed(KeyResult.Why.UNSUPPORTED, e.errorMessage?.toString())
        } catch (e: CreateCredentialProviderConfigurationException) {
            KeyResult.Failed(KeyResult.Why.UNSUPPORTED, e.errorMessage?.toString())
        } catch (e: CreateCredentialException) {
            KeyResult.Failed(KeyResult.Why.OTHER, e.errorMessage?.toString())
        }
    }
}
