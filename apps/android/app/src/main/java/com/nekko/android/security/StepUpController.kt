package com.nekko.android.security

import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.StepUp
import com.nekko.protocol.StepUpChallenge
import com.nekko.protocol.StepUpMethod
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** What the step-up sheet shows. */
data class StepUpUi(
    val phase: Phase = Phase.LOADING,
    /** A key or passkey can be asked (registered, and the computer named its relying party). */
    val offersKey: Boolean = false,
    /** A one-time code is registered. */
    val offersCode: Boolean = false,
    /** Keys are registered but this phone can't ask them (see [CredentialManagerKeys]). */
    val keysUnavailable: Boolean = false,
    /** Something to say under the buttons: a refusal, a key that failed, a code that is not six digits. */
    val error: String? = null,
    val busy: Boolean = false,
) {
    enum class Phase {
        /** Fetching the challenge. */
        LOADING,
        /** Waiting for the owner: key or code. */
        READY,
        /** Nothing registered can answer from a phone: do it on the computer. */
        NO_METHOD,
        /** The guarded call went through. */
        DONE,
    }
}

/**
 * One step-up, from the refusal to the retried call (SK-7). The sheet calls
 * [open], then [useKey] or [useCode] until [StepUpUi.Phase.DONE] or the owner
 * cancels. Every try fetches a fresh challenge first: the computer spends a
 * challenge on any answer, accepted or not.
 *
 * [challenge] is `security:challenge` on the active computer, [retry] sends
 * the guarded call again with the step-up, [keys] the platform FIDO2 client
 * (null where there is none). [computer] names the computer in sentences.
 */
class StepUpController(
    private val challenge: suspend () -> StepUpChallenge,
    private val retry: suspend (StepUpProof) -> Unit,
    private val keys: KeyClient?,
    private val computer: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _ui = MutableStateFlow(StepUpUi())
    val ui: StateFlow<StepUpUi> = _ui.asStateFlow()

    /** The challenge in hand, unspent; null once a try used it. */
    private var current: StepUpChallenge? = null

    /** Fetch the first challenge and say which ways to answer exist. */
    suspend fun open() {
        _ui.value = StepUpUi(phase = StepUpUi.Phase.LOADING, busy = true)
        val c = fetch() ?: return
        show(c)
    }

    /** Ask the security key or passkey, then send the call again with the assertion. */
    suspend fun useKey() {
        val k = keys ?: return fail("This phone can’t use a security key. Use a code instead.")
        busy()
        val c = fresh() ?: return
        val rpId = c.rpId
        if (rpId == null || !c.offersKey) return fail(keysUnavailableText())
        current = null
        when (val r = k.assertion(c.challenge, rpId)) {
            is KeyResult.Ok -> send(r.value)
            KeyResult.Cancelled -> _ui.update { it.copy(busy = false, error = null) }
            is KeyResult.Failed -> fail(keyFailure(r.why))
        }
    }

    /** Send the call again with the six digits [typed] (spaces and dashes allowed). */
    suspend fun useCode(typed: String) {
        val code = StepUp.normalizeCode(typed) ?: return fail("Enter the six digits from your authenticator app.")
        busy()
        // A code is checked without the challenge, but each try still marks the old one spent.
        current = null
        send(StepUpProof.Totp(code))
    }

    private suspend fun send(proof: StepUpProof) {
        try {
            retry(proof)
            _ui.update { it.copy(phase = StepUpUi.Phase.DONE, busy = false, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: RelayException) {
            val refusal = e.refusal ?: PhoneRefusal.parse(e.message)
            val words = refusal?.stepUp?.message ?: e.message?.takeIf { it.isNotBlank() } ?: "$computer didn’t accept that."
            // Fetch the next challenge now, so the methods shown stay current.
            val next = fetch(keepError = words) ?: return
            show(next, error = words)
        } catch (e: Exception) {
            fail(e.message?.takeIf { it.isNotBlank() } ?: "$computer didn’t accept that.")
        }
    }

    /** The unspent challenge if it has time left, else a new one. */
    private suspend fun fresh(): StepUpChallenge? {
        current?.takeIf { !it.isExpired(now()) }?.let { return it }
        return fetch()
    }

    private suspend fun fetch(keepError: String? = null): StepUpChallenge? = try {
        challenge().also { current = it }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        val why = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t reach $computer."
        _ui.update { it.copy(phase = if (it.phase == StepUpUi.Phase.LOADING) StepUpUi.Phase.READY else it.phase, busy = false, error = keepError ?: why) }
        null
    }

    private fun show(c: StepUpChallenge, error: String? = null) {
        val keysRegistered = c.methods.any { it.isFido2 }
        _ui.value = StepUpUi(
            phase = if (c.noWayToAnswer) StepUpUi.Phase.NO_METHOD else StepUpUi.Phase.READY,
            offersKey = c.offersKey && keys != null,
            offersCode = c.offersCode,
            keysUnavailable = keysRegistered && (!c.offersKey || keys == null),
            error = error,
            busy = false,
        )
    }

    private fun busy() = _ui.update { it.copy(busy = true, error = null) }

    private fun fail(message: String) = _ui.update { it.copy(busy = false, error = message) }

    private fun keysUnavailableText() =
        "Security keys and passkeys for $computer can’t be used from this phone yet. Use a code from your authenticator app."

    private fun keyFailure(why: KeyResult.Why): String = when (why) {
        KeyResult.Why.NO_CREDENTIAL -> "No key or passkey on hand is registered for $computer. Try another key, or use a code."
        KeyResult.Why.RP_REFUSED -> keysUnavailableText()
        KeyResult.Why.UNSUPPORTED -> "This phone can’t talk to security keys (Google Play services is missing or out of date). Use a code instead."
        KeyResult.Why.UNREADABLE -> "That key answered in a way $computer can’t check. Use another key or a code."
        KeyResult.Why.OTHER -> "The key didn’t answer. Try again, or use a code."
    }

    companion object {
        /** The sheet's kinds in reading order, for Settings → Security. */
        val KIND_ORDER = listOf(StepUpMethod.SECURITY_KEY, StepUpMethod.PASSKEY, StepUpMethod.TOTP)
    }
}
