package com.nekko.android.security

import com.nekko.protocol.StepUpMethod
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.StepUpRegistration

/**
 * What asking a key or a passkey came to. [Failed.why] says which way, so the
 * sheet can word it (and offer the code).
 */
sealed class KeyResult<out T> {
    data class Ok<T>(val value: T) : KeyResult<T>()
    /** The owner closed the system sheet. Nothing to say. */
    data object Cancelled : KeyResult<Nothing>()
    data class Failed(val why: Why, val detail: String? = null) : KeyResult<Nothing>()

    enum class Why {
        /** Nothing on the key or this phone is registered for the computer. */
        NO_CREDENTIAL,
        /**
         * The platform refused the relying-party id. Expected today: see
         * [CredentialManagerKeys] on Digital Asset Links.
         */
        RP_REFUSED,
        /** No FIDO2 provider (Google Play services missing or too old). */
        UNSUPPORTED,
        /** The answer could not be read (not ES256, missing fields). */
        UNREADABLE,
        OTHER,
    }
}

/**
 * The platform's FIDO2 client ([CredentialManagerKeys] in the app), behind an
 * interface so the step-up flow is testable on the JVM.
 */
interface KeyClient {
    /** An assertion over the computer's challenge (`security:challenge`), for [rpId]. */
    suspend fun assertion(challenge: String, rpId: String): KeyResult<StepUpProof.Assertion>

    /** A new discoverable ES256 credential of [kind] for [rpId] (see [StepUpRegistration]). */
    suspend fun register(
        challenge: String,
        rpId: String,
        rpName: String,
        userId: ByteArray,
        userName: String,
        kind: StepUpMethod,
    ): KeyResult<StepUpRegistration>
}
