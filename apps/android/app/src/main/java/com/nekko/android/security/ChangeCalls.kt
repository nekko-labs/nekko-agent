package com.nekko.android.security

import com.nekko.android.data.Remote
import com.nekko.protocol.ChangeProof
import com.nekko.protocol.ChangeSigner
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * Change actions from this phone on one connection (TASKS.md IO-33, AN-32):
 * every call is signed ([ChangeProof]), and the phone's key is registered
 * with the computer on the first one (trust on first use). Mirrors the
 * iPhone's `ChangeCalls`. The repository keeps one per live connection.
 *
 * A refusal comes back as a [RelayException] whose message says what to do
 * and whose [RelayException.refusal] keeps the computer's code.
 */
class ChangeCalls(
    private val remote: Remote,
    private val signer: ChangeSigner,
    private val deviceId: String,
    private val computer: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Mutex()
    @Volatile private var registered = false
    private var lastTs = 0L

    /**
     * Call a change-class channel with a fresh proof, registering this
     * phone's key first if this connection hasn't yet. [stepUp] (SK-7) rides
     * beside the proof when the computer asked for one.
     */
    suspend fun call(channel: String, args: List<JsonElement>, stepUp: StepUpProof? = null, timeoutMs: Long? = null): JsonElement {
        val list = JsonArray(args)
        return try {
            registerIfNeeded()
            signed(channel, list, stepUp, timeoutMs)
        } catch (e: RelayException) {
            val refusal = e.refusal ?: PhoneRefusal.parse(e.message) ?: throw e
            if (refusal.code != "key-missing") throw plain(e, refusal)
            // The computer lost the key (this phone was paired again there): register and try once more.
            registered = false
            try {
                registerIfNeeded()
                signed(channel, list, stepUp, timeoutMs)
            } catch (again: RelayException) {
                throw plain(again, again.refusal ?: PhoneRefusal.parse(again.message) ?: throw again)
            }
        } catch (_: ChangeProof.Unsignable) {
            throw RelayException("This change can’t be sent from a phone.")
        }
    }

    private fun plain(e: RelayException, refusal: PhoneRefusal): RelayException =
        RelayException(refusal.message(computer) ?: e.message.orEmpty(), refusal)

    private suspend fun registerIfNeeded() {
        if (registered) return
        val key = JsonPrimitive(Base64.getEncoder().encodeToString(signer.publicKey()))
        signed(ChangeProof.KEY_CHANNEL, JsonArray(listOf(key)), stepUp = null, timeoutMs = null)
        registered = true
    }

    /** Never the same timestamp twice: the computer refuses a proof it has seen. */
    private suspend fun nextTs(): Long = lock.withLock {
        lastTs = maxOf(now(), lastTs + 1)
        lastTs
    }

    private suspend fun signed(channel: String, args: JsonArray, stepUp: StepUpProof?, timeoutMs: Long?): JsonElement {
        val proof = ChangeProof.proof(signer, deviceId, channel, args, nextTs())
        return remote.callSigned(channel, args, proof, stepUp, timeoutMs)
    }
}
