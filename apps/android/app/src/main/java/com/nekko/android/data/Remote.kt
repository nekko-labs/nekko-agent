package com.nekko.android.data

import com.nekko.protocol.OkHttpTransport
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayClient
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WsTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Request side of a computer connection: what chat screens need. */
interface Caller {
    suspend fun call(channel: String, vararg args: JsonElement): JsonElement
    suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement
}

/** A live connection to one computer. [RelayRemote] in the app, fakes in tests. */
interface Remote : Caller {
    val status: StateFlow<RelayStatus>
    val events: SharedFlow<Pair<String, JsonElement>>
    val welcome: SharedFlow<WelcomedDevice>
    fun connect()
    fun close()
    fun nudge()
    /** The phone changed network: drop the socket and dial again now. */
    fun reconnect()

    /**
     * A guarded call again with a step-up beside it in the sealed request
     * (SK-7). Connections that can't carry one refuse plainly.
     */
    suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement): JsonElement =
        throw RelayException("This connection can’t send a confirmation.")

    /**
     * A Change action with its signed proof beside the args (AN-32), and a
     * step-up beside that when the computer asked for one. Use [ChangeCalls].
     */
    suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof? = null, timeoutMs: Long? = null): JsonElement =
        throw RelayException("This connection can’t send a confirmation.")
}

fun interface RemoteFactory {
    fun create(config: RelayConfig, scope: CoroutineScope): Remote
}

class RelayRemote(private val client: RelayClient) : Remote {
    override val status get() = client.status
    override val events get() = client.events
    override val welcome get() = client.welcome
    override fun connect() = client.connect()
    override fun close() = client.close()
    override fun nudge() = client.nudge()
    override fun reconnect() = client.reconnect()
    override suspend fun call(channel: String, vararg args: JsonElement) = client.call(channel, *args)
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) =
        client.callWithTimeout(timeoutMs, channel, *args)
    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement) =
        client.callWithStepUp(stepUp, channel, *args)
    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?) =
        if (timeoutMs == null) client.callSigned(channel, args, proof, stepUp) else client.callSigned(channel, args, proof, stepUp, timeoutMs)
}

/** Production factory: one OkHttp transport shared by every connection. */
class RelayRemoteFactory(private val transport: WsTransport = OkHttpTransport()) : RemoteFactory {
    override fun create(config: RelayConfig, scope: CoroutineScope): Remote =
        RelayRemote(RelayClient(config, transport, scope))
}

/**
 * [inner] with the computer's phone refusals (`Not allowed from a paired phone
 * (<code>): ...`) reworded as what to do, for every screen that shows a call's
 * error. The [RelayException.refusal] stays on the rethrown error, so a screen
 * can still tell which refusal it was. Other errors pass through unchanged.
 */
class PlainRefusals(private val inner: Remote, private val computer: () -> String) : Remote by inner {
    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement =
        plain { inner.call(channel, *args) }

    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement =
        plain { inner.callWithTimeout(timeoutMs, channel, *args) }

    override suspend fun callWithStepUp(stepUp: StepUpProof, channel: String, vararg args: JsonElement): JsonElement =
        plain { inner.callWithStepUp(stepUp, channel, *args) }

    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?): JsonElement =
        plain { inner.callSigned(channel, args, proof, stepUp, timeoutMs) }

    private inline fun plain(block: () -> JsonElement): JsonElement = try {
        block()
    } catch (e: RelayException) {
        throw reword(e, computer())
    }

    companion object {
        /** [e] as the owner should read it, or [e] itself when it is not a refusal we can explain. */
        fun reword(e: RelayException, computer: String): RelayException {
            val refusal = e.refusal ?: PhoneRefusal.parse(e.message) ?: return e
            val text = refusal.message(computer) ?: return e
            return RelayException(text, refusal)
        }
    }
}
