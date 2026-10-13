package com.nekko.android

import com.nekko.android.data.Caller
import com.nekko.android.data.Remote
import com.nekko.android.data.RemoteFactory
import com.nekko.android.data.SecureStore
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.util.concurrent.CopyOnWriteArrayList

class FakeStore : SecureStore {
    val map = LinkedHashMap<String, String>()
    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String?) {
        if (value == null) map.remove(key) else map[key] = value
    }
}

data class Call(val channel: String, val args: List<JsonElement>, val timeoutMs: Long?)

/** Records every call; [handler] answers (or throws, or suspends). */
open class FakeCaller(
    var handler: suspend (Call) -> JsonElement = { JsonNull },
) : Caller {
    val calls = CopyOnWriteArrayList<Call>()

    override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
        val c = Call(channel, args.toList(), null)
        calls += c
        return handler(c)
    }

    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement {
        val c = Call(channel, args.toList(), timeoutMs)
        calls += c
        return handler(c)
    }

    fun channels() = calls.map { it.channel }
}

class FakeRemote(val config: RelayConfig, handler: suspend (Call) -> JsonElement) : FakeCaller(handler), Remote {
    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
    var connected = false
    var closed = false
    var nudges = 0

    override fun connect() {
        connected = true
        status.value = RelayStatus(RelayState.CONNECTING)
    }

    override fun close() {
        closed = true
        status.value = RelayStatus(RelayState.IDLE)
    }

    override fun nudge() {
        nudges++
    }

    fun goOnline() {
        status.value = RelayStatus(RelayState.ONLINE)
    }

    fun sayWelcome() {
        welcome.tryEmit(WelcomedDevice(config.deviceId, config.deviceName, "android"))
        goOnline()
    }
}

class FakeRemotes(var handler: suspend (Call) -> JsonElement = { defaultAnswer(it) }) : RemoteFactory {
    val created = CopyOnWriteArrayList<FakeRemote>()
    val last get() = created.last()

    override fun create(config: RelayConfig, scope: CoroutineScope): Remote =
        FakeRemote(config) { handler(it) }.also { created += it }

    companion object {
        fun defaultAnswer(c: Call): JsonElement = when (c.channel) {
            com.nekko.protocol.Channels.SESSIONS_SUMMARIES,
            com.nekko.protocol.Channels.PROVIDERS_LIST,
            com.nekko.protocol.Channels.WORKSPACE_LIST -> JsonArray(emptyList())
            else -> JsonNull
        }
    }
}
